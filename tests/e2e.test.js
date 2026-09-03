'use strict';
/* End-to-end user journeys through the real background worker:
 * install -> block -> navigate -> stats -> bypass/pause/resume -> unblock.
 * Plus options import/export normalization and popup decision parity.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../js/matcher.js');
const { loadBackground } = require('./helpers/load-background');

describe('e2e: fresh install to first block', () => {
  it('install migrates legacy list, opens options, DNR + nav both enforce', async () => {
    const bg = loadBackground({}, { blockedWebsites: [' https://WWW.Facebook.com/ '] });

    await bg.chrome.runtime.onInstalled.fire({ reason: 'install' });
    assert.equal(bg.chrome._tabsCreated.length, 1, 'options opens on install');

    const state = await bg.sendMessage({ type: 'getState' });
    assert.deepEqual(state.sites.map((s) => s.pattern), ['facebook.com']);

    const rules = bg.chrome._dnrRules;
    assert.ok(rules.some((r) => r.condition.urlFilter === '||facebook.com^'), 'DNR rule present');

    // Subdomain navigation blocked via fallback path too
    await bg.fireBeforeNavigate({ tabId: 11, frameId: 0, url: 'https://m.facebook.com/' });
    assert.equal(bg.chrome._tabsUpdated.length, 1);
    const target = bg.chrome._tabsUpdated[0].url;
    assert.match(target, /blocked\.html/);
    assert.match(decodeURIComponent(target), /m\.facebook\.com/);

    const after = await bg.sendMessage({ type: 'getState' });
    assert.equal(after.totalBlocks, 1);
    assert.equal(after.stats['facebook.com'], 1);
    assert.match(after.lastBlocked.url, /m\.facebook\.com/);
  });
});

describe('e2e: wildcard + path rules in one session', () => {
  it('blocks *bet*, youtube shorts; allows watch + lookalikes', async () => {
    const bg = loadBackground({ sites: [] });
    for (const p of ['*bet*', 'youtube.com/shorts']) {
      const r = await bg.sendMessage({ type: 'addSite', pattern: p });
      assert.equal(r.ok, true, p);
    }
    const cases = [
      ['https://foo-bet-bar.com/x', '*bet*'],
      ['https://youtube.com/shorts/abc', 'youtube.com/shorts'],
      ['https://www.youtube.com/shorts/abc', 'youtube.com/shorts'],
      ['https://youtube.com/watch?v=1', null],
      ['https://example.org/', null],
    ];
    for (const [url, want] of cases) {
      const r = await bg.sendMessage({ type: 'checkUrl', url });
      assert.equal(r.match, want, url);
    }
    // DNR mirrors matcher semantics
    const filters = bg.chrome._dnrRules.map((r) => r.condition.urlFilter);
    assert.ok(filters.includes('*bet*'));
    assert.ok(filters.includes('||youtube.com/shorts'));
  });
});

describe('e2e: blocked page allow-for-5-min flow', () => {
  it('tempAllow unblocks, then expiry re-blocks', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'example.com', enabled: true }] });

    await bg.fireBeforeNavigate({ tabId: 5, frameId: 0, url: 'https://example.com/a' });
    assert.equal(bg.chrome._tabsUpdated.length, 1);

    // User clicks "Allow for 5 min" on blocked.html
    const allow = await bg.sendMessage({ type: 'tempAllow', url: 'https://example.com/a', minutes: 5 });
    assert.equal(allow.ok, true);

    bg.chrome._tabsUpdated.length = 0;
    await bg.fireBeforeNavigate({ tabId: 5, frameId: 0, url: 'https://example.com/a' });
    assert.equal(bg.chrome._tabsUpdated.length, 0, 'temp-allowed page loads');

    // Simulate expiry
    bg.getStore().tempAllow['example.com'] = Date.now() - 1;
    await bg.fireBeforeNavigate({ tabId: 5, frameId: 0, url: 'https://example.com/a' });
    assert.equal(bg.chrome._tabsUpdated.length, 1, 'blocks again after expiry');
  });
});

describe('e2e: pause/resume focus flow', () => {
  it('pause allows + clears DNR, alarm scheduled, resume restores', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'a.com', enabled: true }] });
    await bg.sendMessage({ type: 'addSite', pattern: 'b.com' });
    assert.ok(bg.chrome._dnrRules.length >= 2);

    await bg.sendMessage({ type: 'setPaused', pausedUntil: Date.now() + 25 * 60000 });
    assert.equal(bg.chrome._dnrRules.length, 0);
    assert.ok(bg.chrome._alarms['sb-unpause']);
    const whilePaused = await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' });
    assert.equal(whilePaused.match, null);

    // Alarm fires -> rules rebuilt
    await bg.chrome.alarms.onAlarm.fire({ name: 'sb-unpause' });
    await bg.tick(20);

    await bg.sendMessage({ type: 'setPaused', pausedUntil: 0 });
    const resumed = await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' });
    assert.equal(resumed.match, 'a.com');
    assert.ok(bg.chrome._dnrRules.length >= 2);
  });
});

describe('e2e: disable then remove', () => {
  it('toggle off allows, toggle on re-blocks, remove unblocks for good', async () => {
    const bg = loadBackground({ sites: [] });
    await bg.sendMessage({ type: 'addSite', pattern: 'a.com' });
    const { sites } = await bg.sendMessage({ type: 'getState' });
    const id = sites[0].id;

    await bg.sendMessage({ type: 'toggleSite', id, enabled: false });
    assert.equal((await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' })).match, null);

    await bg.sendMessage({ type: 'toggleSite', id, enabled: true });
    assert.equal((await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' })).match, 'a.com');

    await bg.sendMessage({ type: 'removeSite', id, pattern: 'a.com' });
    assert.equal((await bg.sendMessage({ type: 'checkUrl', url: 'https://a.com/' })).match, null);
    assert.deepEqual((await bg.sendMessage({ type: 'getState' })).sites, []);
  });
});

describe('e2e: options import/export parity with matcher', () => {
  it('bulk import normalizes/dedups/skips garbage like the UI does', async () => {
    const bg = loadBackground({ sites: [] });
    const pasted = [
      'https://www.Facebook.com/',
      'facebook.com',          // dupe
      '  YOUTUBE.com/Shorts/ ', // path, case-insensitive
      '*bet*',
      'not a site',            // garbage
      '*.com',                 // over-broad, must be refused
      '',                      // blank
    ];
    let added = 0, skipped = 0;
    for (const line of pasted) {
      const norm = SB.normalize(line);
      if (!norm) continue;
      if (!SB.isValid(norm)) { skipped++; continue; }
      const r = await bg.sendMessage({ type: 'addSite', pattern: norm });
      if (r.ok) added++; else skipped++;
    }
    assert.equal(added, 3);
    assert.equal(skipped, 3);
    const { sites } = await bg.sendMessage({ type: 'getState' });
    assert.deepEqual(sites.map((s) => s.pattern).sort(), ['*bet*', 'facebook.com', 'youtube.com/shorts']);

    // Export shape: one pattern per line
    const exported = sites.map((s) => s.pattern).join('\n');
    assert.match(exported, /facebook\.com/);
    assert.equal(exported.split('\n').length, 3);
  });
});

describe('e2e: popup decisions match background', () => {
  it('popup hostOf + findMatch agree with checkUrl', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'facebook.com', enabled: true }] });
    const hostOf = (url) => {
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        return u.hostname.toLowerCase();
      } catch { return ''; }
    };
    for (const url of ['https://m.facebook.com/feed', 'https://example.com/']) {
      const host = hostOf(url).replace(/^www\./, '');
      const state = await bg.sendMessage({ type: 'getState' });
      const popupVerdict = host ? SB.findMatch(url, state.sites) : null;
      const bgVerdict = (await bg.sendMessage({ type: 'checkUrl', url })).match;
      assert.equal(popupVerdict, bgVerdict, url);
    }
    assert.equal(hostOf('chrome://extensions/'), '');
  });
});

describe('e2e: stats accumulate across repeated blocks', () => {
  it('three navigations -> totalBlocks 3, per-pattern counts', async () => {
    const bg = loadBackground({ sites: [{ id: '1', pattern: 'a.com', enabled: true }] });
    await bg.fireBeforeNavigate({ tabId: 1, frameId: 0, url: 'https://a.com/1' });
    await bg.fireHistoryUpdated({ tabId: 1, frameId: 0, url: 'https://a.com/2' });
    await bg.fireTabsUpdated(1, 'https://a.com/3');
    const state = await bg.sendMessage({ type: 'getState' });
    assert.equal(state.totalBlocks, 3);
    assert.equal(state.stats['a.com'], 3);
  });
});
