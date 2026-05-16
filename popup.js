const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/;

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

    const html = await fetchPullRequestHtml(prBaseUrl);
    const patched = injectBaseTag(html, 'https://github.com/');
    await loadIntoIframe(frame, patched);

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

async function fetchPullRequestHtml(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
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

function loadIntoIframe(frame, srcdoc) {
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
