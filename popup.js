const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/;
const THEME_STORAGE_KEY = 'gh-cb-theme-v1';

applyTheme(loadCachedTheme());

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('refresh-button').addEventListener('click', () => main(true));
  document.getElementById('reload-link').addEventListener('click', (event) => {
    event.preventDefault();
    main(true);
  });
  main();
});

async function main(forceReload = false) {
  const frame = document.getElementById('conversation-frame');
  const message = document.getElementById('message');
  const messageText = document.getElementById('message-text');
  const reloadLink = document.getElementById('reload-link');
  const refreshButton = document.getElementById('refresh-button');

  const showMessage = (text, canReload = false) => {
    messageText.textContent = text;
    reloadLink.hidden = !canReload;
    message.hidden = false;
    frame.hidden = true;
  };
  const hideMessage = () => { message.hidden = true; };

  try {
    refreshButton.disabled = true;
    const tab = await getActiveTab();
    const match = tab && tab.url ? PR_URL_RE.exec(tab.url) : null;
    if (!match) {
      showMessage('Open a GitHub Pull Request page first.');
      return;
    }

    const [, owner, repo, num] = match;
    const prBaseUrl = `https://github.com/${owner}/${repo}/pull/${num}`;

    showMessage('Loading conversation…');

    const response = await chrome.runtime.sendMessage({
      type: 'get-conversation',
      url: prBaseUrl,
      forceReload,
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Failed to fetch PR page.');
    }
    if (response.theme) {
      applyTheme(response.theme);
      saveCachedTheme(response.theme);
    }
    const patched = injectBaseTag(response.html, prBaseUrl);
    await loadIntoIframe(frame, patched, response.savedScrollY || 0);
    attachScrollSaver(frame, prBaseUrl);

    hideMessage();
    frame.hidden = false;
  } catch (err) {
    console.error(err);
    showMessage(`Failed to load conversation: ${err.message || err}`, true);
  } finally {
    refreshButton.disabled = false;
  }
}

function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]))
  );
}

function loadCachedTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveCachedTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
  } catch (e) {
    // ignore quota or disabled storage
  }
}

function getIframeScrollY(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return null;
    const el = doc.scrollingElement || doc.documentElement || doc.body;
    return el ? el.scrollTop : null;
  } catch (e) {
    return null;
  }
}

function setIframeScrollY(frame, y) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    if (doc.scrollingElement) doc.scrollingElement.scrollTop = y;
    if (doc.documentElement) doc.documentElement.scrollTop = y;
    if (doc.body) doc.body.scrollTop = y;
  } catch (e) {
    // ignore
  }
}

function attachScrollSaver(frame, prBaseUrl) {
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    let scheduled = false;
    const save = () => {
      scheduled = false;
      const y = getIframeScrollY(frame);
      if (y === null) return;
      chrome.runtime.sendMessage({ type: 'save-scroll', prBaseUrl, scrollY: y }).catch(() => {});
    };
    doc.addEventListener('scroll', () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(save, 100);
    }, { passive: true, capture: true });
  } catch (e) {}
}

function attachLinkHandler(frame) {
  const doc = frame.contentDocument;
  if (!doc) return;

  doc.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const anchor = event.target.closest && event.target.closest('a[href]');
    if (!anchor) return;

    let url;
    try {
      url = new URL(anchor.getAttribute('href'), doc.baseURI);
    } catch (e) {
      return;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // GitHub cannot be loaded as a child of the extension. Open links in a
    // regular tab instead, which also leaves the user's current PR untouched.
    event.preventDefault();
    chrome.tabs.create({ url: url.href });
  });
}

function attachReactionHandler(frame) {
  const doc = frame.contentDocument;
  if (!doc) return;

  doc.addEventListener('submit', async (event) => {
    const form = event.target;
    const submitter = event.submitter;
    const action = submitter && submitter.hasAttribute('formaction')
      ? submitter.formAction
      : form.action;

    let url;
    try {
      url = new URL(action, doc.baseURI);
    } catch (e) {
      return;
    }

    if (url.hostname !== 'github.com' || !url.pathname.includes('/reactions')) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (submitter) submitter.disabled = true;

    try {
      const formData = new FormData(form, submitter);
      const response = await chrome.runtime.sendMessage({
        type: 'submit-reaction',
        url: url.href,
        fields: Array.from(formData.entries()),
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Failed to update reaction.');
      }
      await main(true);
    } catch (err) {
      console.error(err);
      const message = document.getElementById('message');
      document.getElementById('message-text').textContent = `Failed to update reaction: ${err.message || err}`;
      document.getElementById('reload-link').hidden = false;
      message.hidden = false;
      frame.hidden = true;
    } finally {
      if (submitter) submitter.disabled = false;
    }
  }, true);
}

function resolveActiveTheme(themeInfo) {
  if (!themeInfo) return null;
  const { colorMode, lightTheme, darkTheme } = themeInfo;
  if (colorMode === 'dark') return darkTheme;
  if (colorMode === 'light') return lightTheme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? darkTheme : lightTheme;
}

function applyTheme(themeInfo) {
  const resolved = resolveActiveTheme(themeInfo);
  if (resolved) document.documentElement.setAttribute('data-resolved-theme', resolved);
}

function injectBaseTag(html, baseHref) {
  const tag = `<base href="${baseHref}">`;
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const idx = headOpen.index + headOpen[0].length;
    return html.slice(0, idx) + tag + html.slice(idx);
  }
  return `<head>${tag}</head>` + html;
}

function loadIntoIframe(frame, srcdoc, scrollY = 0) {
  return new Promise((resolve, reject) => {
    let timer;
    const onLoad = () => {
      clearTimeout(timer);
      frame.removeEventListener('load', onLoad);
      try {
        const doc = frame.contentDocument;
        const target = doc && doc.querySelector('.pull-discussion-timeline .js-discussion');
        if (!target) {
          reject(new Error('Conversation section not found on the PR page.'));
          return;
        }
        doc.body.innerHTML = '';
        doc.body.appendChild(target);
        attachLinkHandler(frame);
        attachReactionHandler(frame);
        if (scrollY > 0) {
          requestAnimationFrame(() => setIframeScrollY(frame, scrollY));
        }
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    frame.addEventListener('load', onLoad);
    timer = setTimeout(() => {
      frame.removeEventListener('load', onLoad);
      reject(new Error('Timed out loading PR page.'));
    }, 20000);
    frame.srcdoc = srcdoc;
  });
}
