/* SiteBlock background service worker (MV3).
 * Primary enforcement: declarativeNetRequest dynamic rules (instant, no flash).
 * Fallbacks: webNavigation (main frames + SPA history) + tabs.onUpdated.
 * State lives in chrome.storage.local (10MB, no sync throttling).
 */
importScripts('matcher.js');

const SB = globalThis.SiteBlock;
const RULE_OFFSET = 1000;
const MAX_RULES = 4000;

const storage = {
  get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  },
  set(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  },
};

/** Migrate legacy `blockedWebsites` (sync or local) into `sites`. */
async function migrateIfNeeded() {
  const local = await storage.get(['sites', 'blockedWebsites', 'pausedUntil', 'tempAllow', 'stats', 'totalBlocks']);
  if (Array.isArray(local.sites)) return local;

  let legacy = local.blockedWebsites || [];
  try {
    const sync = await new Promise((r) => chrome.storage.sync.get(['blockedWebsites'], r));
    if (Array.isArray(sync.blockedWebsites) && sync.blockedWebsites.length > legacy.length) {
      legacy = sync.blockedWebsites;
    }
  } catch (e) { /* sync may be unavailable */ }

  const seen = new Set();
  const sites = [];
  for (const raw of legacy) {
    const pattern = SB.normalize(raw);
    if (!pattern || !SB.isValid(pattern) || seen.has(pattern)) continue;
    seen.add(pattern);
    sites.push({ id: 'm' + Math.random().toString(36).slice(2, 10), pattern, enabled: true, addedAt: Date.now() });
  }
  await storage.set({
    sites,
    pausedUntil: local.pausedUntil || 0,
    tempAllow: local.tempAllow || {},
    stats: local.stats || {},
    totalBlocks: local.totalBlocks || 0,
  });
  try { await new Promise((r) => chrome.storage.sync.remove(['blockedWebsites'], r)); } catch (e) {}
  return storage.get(['sites', 'pausedUntil', 'tempAllow']);
}

function isPaused(pausedUntil) {
  return typeof pausedUntil === 'number' && pausedUntil > Date.now();
}

function tempAllowsExpired(tempAllow) {
  const now = Date.now();
  let changed = false;
  const next = {};
  for (const [k, exp] of Object.entries(tempAllow || {})) {
    if (typeof exp === 'number' && exp > now) next[k] = exp;
    else changed = true;
  }
  return { next, changed };
}

/** Is this hostname temporarily allowed (exact host or parent pattern)? */
function isTempAllowed(hostname, tempAllow) {
  const now = Date.now();
  for (const [key, exp] of Object.entries(tempAllow || {})) {
    if (typeof exp !== 'number' || exp <= now) continue;
    const k = String(key).toLowerCase();
    if (hostname === k || hostname.endsWith('.' + k)) return true;
  }
  return false;
}

/** Rebuild DNR dynamic rules from stored sites. Call on start + changes. */
async function rebuildRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const state = await migrateIfNeeded();
    const sites = Array.isArray(state.sites) ? state.sites : [];
    let { tempAllow = {}, pausedUntil = 0 } = state;

    const pruned = tempAllowsExpired(tempAllow);
    if (pruned.changed) {
      await storage.set({ tempAllow: pruned.next });
      tempAllow = pruned.next;
    }
    if (isPaused(pausedUntil)) {
      const existing = await chrome.declarativeNetRequest.getDynamicRules();
      if (existing.length) {
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: existing.map((r) => r.id),
        });
      }
      return;
    }

    const rules = [];
    let id = RULE_OFFSET;
    for (const site of sites) {
      if (!site || site.enabled === false) continue;
      const pattern = SB.normalize(site.pattern);
      if (!SB.isValid(pattern)) continue;
      const urlFilter = SB.toDnrFilter(pattern);
      if (!urlFilter) continue;
      if (rules.length >= MAX_RULES) break;
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { extensionPath: '/html/blocked.html' } },
        condition: { urlFilter, resourceTypes: ['main_frame'] },
      });
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: rules,
    });
  } catch (e) {
    // DNR unavailable (e.g. permissions) — navigation fallback still works.
  }
}

function blockedPageUrl(originalUrl, pattern) {
  return (
    chrome.runtime.getURL('html/blocked.html') +
    '?u=' + encodeURIComponent(originalUrl) +
    '&p=' + encodeURIComponent(pattern || '')
  );
}

async function recordBlock(originalUrl, pattern) {
  try {
    const s = await storage.get(['stats', 'totalBlocks', 'lastBlocked']);
    const stats = s.stats || {};
    stats[pattern] = (stats[pattern] || 0) + 1;
    await storage.set({
      stats,
      totalBlocks: (s.totalBlocks || 0) + 1,
      lastBlocked: { url: originalUrl, pattern, time: Date.now() },
    });
  } catch (e) {}
}

/** Core decision: should this URL be blocked right now? */
async function shouldBlock(urlString) {
  const parsed = SB.parseUrl(urlString);
  if (!parsed) return null;
  const state = await storage.get(['sites', 'pausedUntil', 'tempAllow']);
  if (isPaused(state.pausedUntil)) return null;
  if (isTempAllowed(parsed.hostname, state.tempAllow)) return null;
  const match = SB.findMatch(urlString, state.sites || []);
  return match ? { pattern: match, hostname: parsed.hostname } : null;
}

async function redirectTab(tabId, urlString, pattern) {
  try {
    await recordBlock(urlString, pattern);
    await chrome.tabs.update(tabId, { url: blockedPageUrl(urlString, pattern) });
  } catch (e) {}
}

// ---- Event wiring ----

chrome.runtime.onInstalled.addListener(async (details) => {
  await migrateIfNeeded();
  await rebuildRules();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('html/options.html') });
  }
});

chrome.runtime.onStartup.addListener(rebuildRules);

// Debounced rebuild on storage changes (options/popup write often).
let rebuildTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('sites' in changes || 'pausedUntil' in changes || 'tempAllow' in changes)) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuildRules, 150);
});

// Fallback 1: main-frame navigations (covers cases DNR misses).
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    try {
      if (details.frameId !== 0 || details.tabId < 0) return;
      if (!details.url || !/^https?:\/\//i.test(details.url)) return;
      const hit = await shouldBlock(details.url);
      if (hit) await redirectTab(details.tabId, details.url, hit.pattern);
    } catch (e) {}
  },
  { url: [{ schemes: ['http', 'https'] }] }
);

// Fallback 2: SPA history navigations (YouTube, Reddit, etc. use pushState).
chrome.webNavigation.onHistoryStateUpdated.addListener(
  async (details) => {
    try {
      if (details.frameId !== 0 || details.tabId < 0) return;
      if (!details.url || !/^https?:\/\//i.test(details.url)) return;
      const hit = await shouldBlock(details.url);
      if (hit) await redirectTab(details.tabId, details.url, hit.pattern);
    } catch (e) {}
  },
  { url: [{ schemes: ['http', 'https'] }] }
);

// Fallback 3: tab URL changes (covers restored tabs, omnibox edge cases).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  try {
    if (!changeInfo.url || !/^https?:\/\//i.test(changeInfo.url)) return;
    const hit = await shouldBlock(changeInfo.url);
    if (hit) await redirectTab(tabId, changeInfo.url, hit.pattern);
  } catch (e) {}
});

// Pause expiry: wake up and re-enable rules.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sb-unpause') rebuildRules();
});
async function scheduleUnpause(pausedUntil) {
  try {
    await chrome.alarms.clear('sb-unpause');
    const delay = pausedUntil - Date.now();
    if (delay > 0 && delay < 2 * 24 * 60 * 60 * 1000) {
      chrome.alarms.create('sb-unpause', { when: pausedUntil + 500 });
    }
  } catch (e) {}
}

// ---- Popup / options / blocked-page API ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await storage.get(['sites', 'pausedUntil', 'tempAllow', 'stats', 'totalBlocks', 'lastBlocked']);
    const sites = Array.isArray(state.sites) ? state.sites : [];

    switch (msg && msg.type) {
      case 'getState': {
        sendResponse({
          ok: true,
          sites,
          pausedUntil: state.pausedUntil || 0,
          tempAllow: state.tempAllow || {},
          stats: state.stats || {},
          totalBlocks: state.totalBlocks || 0,
          lastBlocked: state.lastBlocked || null,
        });
        break;
      }
      case 'checkUrl': {
        const hit = await shouldBlock(msg.url);
        sendResponse({ ok: true, match: hit ? hit.pattern : null });
        break;
      }
      case 'addSite': {
        const pattern = SB.normalize(msg.pattern);
        if (!SB.isValid(pattern)) { sendResponse({ ok: false, error: 'Invalid site pattern.' }); break; }
        if (sites.some((s) => SB.normalize(s.pattern) === pattern)) {
          sendResponse({ ok: false, error: 'Already blocked.' }); break;
        }
        sites.push({ id: 's' + Math.random().toString(36).slice(2, 10), pattern, enabled: true, addedAt: Date.now() });
        await storage.set({ sites });
        await rebuildRules();
        sendResponse({ ok: true, pattern });
        break;
      }
      case 'removeSite': {
        await storage.set({ sites: sites.filter((s) => s.id !== msg.id && SB.normalize(s.pattern) !== SB.normalize(msg.pattern)) });
        await rebuildRules();
        sendResponse({ ok: true });
        break;
      }
      case 'toggleSite': {
        const next = sites.map((s) =>
          s.id === msg.id ? { ...s, enabled: msg.enabled !== undefined ? !!msg.enabled : s.enabled === false } : s
        );
        await storage.set({ sites: next });
        await rebuildRules();
        sendResponse({ ok: true });
        break;
      }
      case 'setPaused': {
        const pausedUntil = msg.pausedUntil || 0;
        await storage.set({ pausedUntil });
        await scheduleUnpause(pausedUntil);
        await rebuildRules();
        sendResponse({ ok: true });
        break;
      }
      case 'tempAllow': {
        // Allow a hostname (or its exact pattern) for N minutes.
        const minutes = Math.max(1, Math.min(24 * 60, Number(msg.minutes) || 5));
        let host = '';
        try { host = new URL(msg.url).hostname.toLowerCase(); } catch (e) {}
        if (!host) { sendResponse({ ok: false, error: 'Bad URL.' }); break; }
        const tempAllow = { ...(state.tempAllow || {}), [host]: Date.now() + minutes * 60 * 1000 };
        await storage.set({ tempAllow });
        await rebuildRules();
        sendResponse({ ok: true, until: tempAllow[host] });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message.' });
    }
  })();
  return true; // async response
});
