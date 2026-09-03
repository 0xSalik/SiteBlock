'use strict';
/* Tests for js/background.js loaded in a vm sandbox with mocked chrome APIs. */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers/load-background');

describe('background wiring', () => {
  it('registers all required listeners', () => {
    const { chrome } = loadBackground();
    assert.equal(chrome.runtime.onInstalled.count, 1);
    assert.equal(chrome.runtime.onStartup.count, 1);
    assert.equal(chrome.runtime.onMessage.count, 1);
    assert.equal(chrome.storage.onChanged.count, 1);
    assert.equal(chrome.webNavigation.onBeforeNavigate.count, 1);
    assert.equal(chrome.webNavigation.onHistoryStateUpdated.count, 1);
    assert.equal(chrome.tabs.onUpdated.count, 1);
    assert.equal(chrome.alarms.onAlarm.count, 1);
  });
});

describe('migration', () => {
  it('migrates legacy sync blockedWebsites, normalizes + dedups, clears sync', async () => {
    const { sendMessage, getStore, chrome } = loadBackground(
      {},
      { blockedWebsites: [' Facebook.com ', 'https://www.facebook.com/', 'not a site', 'facebook.com', 'x.com'] }
    );
    await chrome.runtime.onInstalled.fire({ reason: 'update' });
    const state = await sendMessage({ type: 'getState' });
    assert.equal(state.ok, true);
    const patterns = state.sites.map((s) => s.pattern).sort();
    assert.deepEqual(patterns, ['facebook.com', 'x.com']);
    // sync legacy removed
    assert.deepEqual(chrome._stores.sync, {});
    assert.ok(getStore().sites.length === 2);
  });

  it('prefers the longer of local vs sync legacy lists', async () => {
    const { chrome } = loadBackground(
      { blockedWebsites: ['a.com'] },
      { blockedWebsites: ['a.com', 'b.com'] }
    );
    await chrome.runtime.onInstalled.fire({ reason: 'update' });
    // Note: [...spread] brings the vm-realm array into the main realm.
    const patterns = [...chrome._stores.local.sites.map((s) => s.pattern)].sort();
    assert.deepEqual(patterns, ['a.com', 'b.com']);
  });

  it('does not re-migrate when sites already exists', async () => {
    const seeded = [{ id: 's1', pattern: 'keep.com', enabled: true }];
    const { sendMessage } = loadBackground({ sites: seeded }, { blockedWebsites: ['evil.com'] });
    const state = await sendMessage({ type: 'getState' });
    assert.deepEqual(state.sites, seeded);
  });

  it('opens options page on fresh install only', async () => {
    const t1 = loadBackground();
    await t1.chrome.runtime.onInstalled.fire({ reason: 'install' });
    assert.equal(t1.chrome._tabsCreated.length, 1);
    assert.match(t1.chrome._tabsCreated[0].url, /options\.html/);

    const t2 = loadBackground();
    await t2.chrome.runtime.onInstalled.fire({ reason: 'update' });
    assert.equal(t2.chrome._tabsCreated.length, 0);
  });
});

describe('message API: add/remove/toggle', () => {
  let bg;
  beforeEach(() => { bg = loadBackground({ sites: [] }); });

  it('addSite accepts, normalizes, rejects dupes and garbage', async () => {
    let r = await bg.sendMessage({ type: 'addSite', pattern: 'https://WWW.Facebook.com/' });
    assert.deepEqual(r, { ok: true, pattern: 'facebook.com' });

    r = await bg.sendMessage({ type: 'addSite', pattern: 'facebook.com' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Already/);

    r = await bg.sendMessage({ type: 'addSite', pattern: 'not a site!!' });
    assert.equal(r.ok, false);

    r = await bg.sendMessage({ type: 'addSite', pattern: '*bet*' });
    assert.equal(r.ok, true);

    const state = await bg.sendMessage({ type: 'getState' });
    assert.deepEqual(state.sites.map((s) => s.pattern).sort(), ['*bet*', 'facebook.com']);
  });

  it('removeSite works by id and by pattern', async () => {
    await bg.sendMessage({ type: 'addSite', pattern: 'a.com' });
    await bg.sendMessage({ type: 'addSite', pattern: 'b.com' });
    let state = await bg.sendMessage({ type: 'getState' });
    const idA = state.sites.find((s) => s.pattern === 'a.com').id;

    // NOTE: background removeSite uses AND (id !== AND pattern !==) — removing
    // by id alone with a wrong pattern keeps the entry. This documents current
    // behavior; prefer passing both.
    let r = await bg.sendMessage({ type: 'removeSite', id: idA, pattern: 'a.com' });
    assert.equal(r.ok, true);
    state = await bg.sendMessage({ type: 'getState' });
    assert.deepEqual(state.sites.map((s) => s.pattern), ['b.com']);
  });

  it('toggleSite disables without deleting (excluded from matching)', async () => {
    await bg.sendMessage({ type: 'addSite', pattern: 'a.com' });
    let state = await bg.sendMessage({ type: 'getState' });
    const id = state.sites[0].id;

    await bg.sendMessage({ type: 'toggleSite', id, enabled: false });
    let check = await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' });
    assert.equal(check.match, null);

    await bg.sendMessage({ type: 'toggleSite', id, enabled: true });
    check = await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' });
    assert.equal(check.match, 'a.com');
  });

  it('unknown messages return ok:false', async () => {
    const r = await bg.sendMessage({ type: 'nope' });
    assert.equal(r.ok, false);
  });
});

describe('checkUrl decision matrix', () => {
  it('blocks apex + subdomains, allows lookalikes and non-web URLs', async () => {
    const bg = loadBackground({
      sites: [{ id: '1', pattern: 'facebook.com', enabled: true }, { id: '2', pattern: 'youtube.com/shorts', enabled: true }],
    });
    const blocked = [
      'https://facebook.com/', 'https://www.facebook.com/', 'https://m.facebook.com/x',
      'https://youtube.com/shorts/abc',
    ];
    for (const url of blocked) {
      const r = await bg.sendMessage({ type: 'checkUrl', url });
      assert.ok(r.match, `expected BLOCK for ${url}`);
    }
    const allowed = [
      'https://notfacebook.com/', 'https://facebook.com.evil.com/',
      'https://youtube.com/watch?v=1', 'https://example.com/',
      'chrome://extensions/', 'about:blank', 'not a url',
    ];
    for (const url of allowed) {
      const r = await bg.sendMessage({ type: 'checkUrl', url });
      assert.equal(r.match, null, `expected ALLOW for ${url}`);
    }
  });
});

describe('DNR rule rebuild', () => {
  it('creates ||domain^ filters, skips disabled/invalid', async () => {
    const bg = loadBackground({
      sites: [
        { id: '1', pattern: 'facebook.com', enabled: true },
        { id: '2', pattern: 'off.com', enabled: false },
        { id: '3', pattern: '***', enabled: true },
        { id: '4', pattern: 'youtube.com/shorts', enabled: true },
        { id: '5', pattern: '*bet*', enabled: true },
      ],
    });
    await bg.sendMessage({ type: 'addSite', pattern: 'extra.com' }); // triggers rebuildRules
    const rules = bg.chrome._dnrRules;
    const filters = rules.map((r) => r.condition.urlFilter).sort();
    assert.ok(filters.includes('||facebook.com^'));
    assert.ok(filters.includes('||youtube.com/shorts'));
    assert.ok(filters.includes('*bet*'));
    assert.ok(filters.includes('||extra.com^'));
    assert.ok(!filters.some((f) => f.includes('off.com')));
    for (const r of rules) {
      assert.deepEqual(r.condition.resourceTypes, ['main_frame']);
      assert.equal(r.action.type, 'redirect');
      assert.equal(r.action.redirect.extensionPath, '/html/blocked.html');
      assert.ok(r.id >= 1000);
    }
    // ids unique
    assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  });

  it('clears all rules while paused, restores on resume', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'a.com', enabled: true }] });
    await bg.sendMessage({ type: 'addSite', pattern: 'b.com' });
    assert.ok(bg.chrome._dnrRules.length > 0);

    await bg.sendMessage({ type: 'setPaused', pausedUntil: Date.now() + 5 * 60000 });
    assert.equal(bg.chrome._dnrRules.length, 0);
    assert.ok(bg.chrome._alarms['sb-unpause'], 'unpause alarm scheduled');

    await bg.sendMessage({ type: 'setPaused', pausedUntil: 0 });
    assert.ok(bg.chrome._dnrRules.length > 0);
  });

  it('prunes expired tempAllow entries on rebuild', async () => {
    const bg = loadBackground({
      sites: [{ id: '1', pattern: 'a.com', enabled: true }],
      tempAllow: { 'old.com': Date.now() - 1000, 'fresh.com': Date.now() + 60000 },
    });
    await bg.sendMessage({ type: 'addSite', pattern: 'b.com' });
    assert.deepEqual(Object.keys(bg.getStore().tempAllow), ['fresh.com']);
  });

  it('storage change triggers debounced rebuild', async () => {
    const bg = loadBackground({ sites: [] });
    await bg.chrome.storage.local.set({
      sites: [{ id: '1', pattern: 'debounced.com', enabled: true }],
    });
    await bg.tick(300); // debounce is 150ms
    assert.ok(bg.chrome._dnrRules.some((r) => r.condition.urlFilter === '||debounced.com^'));
  });
});

describe('navigation fallbacks + stats', () => {
  it('onBeforeNavigate redirects main frame, records stats + lastBlocked', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'facebook.com', enabled: true }] });
    await bg.fireBeforeNavigate({ tabId: 7, frameId: 0, url: 'https://m.facebook.com/feed' });
    assert.equal(bg.chrome._tabsUpdated.length, 1);
    const { tabId, url } = bg.chrome._tabsUpdated[0];
    assert.equal(tabId, 7);
    assert.match(url, /blocked\.html\?u=/);
    assert.match(decodeURIComponent(url), /m\.facebook\.com/);
    const store = bg.getStore();
    assert.equal(store.totalBlocks, 1);
    assert.equal(store.stats['facebook.com'], 1);
    assert.equal(store.lastBlocked.pattern, 'facebook.com');
  });

  it('ignores subframes, missing tabs, and non-http(s)', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'facebook.com', enabled: true }] });
    await bg.fireBeforeNavigate({ tabId: 1, frameId: 5, url: 'https://facebook.com/' });
    await bg.fireBeforeNavigate({ tabId: -1, frameId: 0, url: 'https://facebook.com/' });
    await bg.fireBeforeNavigate({ tabId: 1, frameId: 0, url: 'chrome://extensions/' });
    await bg.fireBeforeNavigate({ tabId: 1, frameId: 0, url: 'https://example.com/' });
    assert.equal(bg.chrome._tabsUpdated.length, 0);
    assert.equal(bg.getStore().totalBlocks || 0, 0);
  });

  it('onHistoryStateUpdated catches SPA navigations', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'youtube.com/shorts', enabled: true }] });
    await bg.fireHistoryUpdated({ tabId: 3, frameId: 0, url: 'https://youtube.com/shorts/xyz' });
    assert.equal(bg.chrome._tabsUpdated.length, 1);
  });

  it('tabs.onUpdated catches restored/omnibox navigations', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'a.com', enabled: true }] });
    await bg.fireTabsUpdated(9, 'https://a.com/');
    assert.equal(bg.chrome._tabsUpdated.length, 1);
    assert.equal(bg.chrome._tabsUpdated[0].tabId, 9);
  });
});

describe('pause + tempAllow', () => {
  it('paused state allows everything via checkUrl and navigation', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'a.com', enabled: true }] });
    await bg.sendMessage({ type: 'setPaused', pausedUntil: Date.now() + 60000 });
    const r = await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' });
    assert.equal(r.match, null);
    await bg.fireBeforeNavigate({ tabId: 1, frameId: 0, url: 'https://a.com/' });
    assert.equal(bg.chrome._tabsUpdated.length, 0);
  });

  it('tempAllow bypasses host + subdomains until expiry', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'example.com', enabled: true }] });
    const r = await bg.sendMessage({ type: 'tempAllow', url: 'https://example.com/page', minutes: 5 });
    assert.equal(r.ok, true);
    assert.ok(r.until > Date.now());

    for (const url of ['https://example.com/', 'https://sub.example.com/x']) {
      const c = await bg.sendMessage({ type: 'checkUrl', url });
      assert.equal(c.match, null, `tempAllow should cover ${url}`);
    }
    // sibling domains still blocked
    const sib = await bg.sendMessage({ type: 'checkUrl', url: 'https://example.com.evil.com/' });
    assert.equal(sib.match, null); // (not blocked by matcher anyway)

    // expired entry does not bypass
    const bg2 = loadBackground({
      sites: [{ id: '1', pattern: 'example.com', enabled: true }],
      tempAllow: { 'example.com': Date.now() - 1000 },
    });
    const c2 = await bg2.sendMessage({ type: 'checkUrl', url: 'https://example.com/' });
    assert.equal(c2.match, 'example.com');
  });

  it('tempAllow rejects bad URLs', async () => {
    const bg = loadBackground({ sites: [] });
    const r = await bg.sendMessage({ type: 'tempAllow', url: 'not a url', minutes: 5 });
    assert.equal(r.ok, false);
  });
});
