const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/;
const THEME_STORAGE_KEY = 'gh-cb-theme-v1';

applyTheme(loadCachedTheme());

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const frame = document.getElementById('conversation-frame');
  const message = document.getElementById('message');

  const showMessage = (text) => {
    message.textContent = text;
    message.hidden = false;
    frame.hidden = true;
  };
  const hideMessage = () => { message.hidden = true; };

  try {
    const tab = await getActiveTab();
    const match = tab && tab.url ? PR_URL_RE.exec(tab.url) : null;
    if (!match) {
      showMessage('Open a GitHub Pull Request page first.');
      return;
    }

    const [, owner, repo, num] = match;
    const prBaseUrl = `https://github.com/${owner}/${repo}/pull/${num}`;

    showMessage('Loading conversation…');

    const response = await chrome.runtime.sendMessage({ type: 'get-conversation', url: prBaseUrl });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Failed to fetch PR page.');
    }
    if (response.theme) {
      applyTheme(response.theme);
      saveCachedTheme(response.theme);
    }
    const patched = injectBaseTag(response.html, 'https://github.com/');
    await loadIntoIframe(frame, patched, response.savedScrollY || 0);
    attachScrollSaver(frame, prBaseUrl);

    hideMessage();
    frame.hidden = false;
  } catch (err) {
    console.error(err);
    showMessage(`Failed to load conversation: ${err.message || err}`);
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
