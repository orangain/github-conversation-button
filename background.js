const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/;
const CACHE_TTL_MS = 2 * 60 * 1000;

const cache = new Map();
const inFlight = new Map();

function getPrBaseUrl(url) {
  const m = url && PR_URL_RE.exec(url);
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
}

function parseGitHubTheme(html) {
  const htmlTag = html.match(/<html[^>]*>/i);
  if (!htmlTag) return null;
  const tag = htmlTag[0];
  const get = (name) => {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'i'));
    return m ? m[1] : null;
  };
  return {
    colorMode: get('data-color-mode') || 'auto',
    lightTheme: get('data-light-theme') || 'light',
    darkTheme: get('data-dark-theme') || 'dark',
  };
}

async function fetchAndCache(prBaseUrl) {
  if (inFlight.has(prBaseUrl)) return inFlight.get(prBaseUrl);
  const promise = (async () => {
    const res = await fetch(prBaseUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${prBaseUrl}`);
    const html = await res.text();
    const theme = parseGitHubTheme(html);
    const entry = { html, theme, timestamp: Date.now() };
    cache.set(prBaseUrl, entry);
    return entry;
  })();
  inFlight.set(prBaseUrl, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(prBaseUrl);
  }
}

function prefetch(prBaseUrl) {
  const entry = cache.get(prBaseUrl);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) return;
  fetchAndCache(prBaseUrl).catch((err) => {
    console.warn('Prefetch failed:', prBaseUrl, err);
  });
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab.url;
  const base = getPrBaseUrl(url);
  if (base) prefetch(base);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const base = getPrBaseUrl(tab.url);
    if (base) prefetch(base);
  } catch (e) {
    // tab may be gone; ignore
  }
});

async function prefetchExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://github.com/*' });
    for (const tab of tabs) {
      const base = getPrBaseUrl(tab.url);
      if (base) prefetch(base);
    }
  } catch (e) {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(prefetchExistingTabs);
chrome.runtime.onStartup.addListener(prefetchExistingTabs);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'get-conversation' || !msg.url) return;
  (async () => {
    const cached = cache.get(msg.url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      sendResponse({ ok: true, html: cached.html, theme: cached.theme, fromCache: true });
      return;
    }
    try {
      const entry = await fetchAndCache(msg.url);
      sendResponse({ ok: true, html: entry.html, theme: entry.theme, fromCache: false });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});
