/* SiteBlock popup logic */
(function () {
  const $ = (id) => document.getElementById(id);
  const SB = window.SiteBlock;

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  async function currentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.hostname.toLowerCase();
    } catch (e) { return ''; }
  }

  function fmtPaused(until) {
    const ms = until - Date.now();
    if (ms <= 0) return '';
    const m = Math.round(ms / 60000);
    if (m < 60) return `Paused for ${m}m`;
    return `Paused for ${(m / 60).toFixed(1)}h`;
  }

  async function refresh() {
    const tab = await currentTab();
    const url = tab && tab.url ? tab.url : '';
    const host = hostOf(url).replace(/^www\./, '');
    $('currentHost').textContent = host || '(not a web page)';

    const state = await send({ type: 'getState' });
    if (!state || !state.ok) { $('msg').textContent = 'Could not reach background worker.'; return; }

    const paused = state.pausedUntil && state.pausedUntil > Date.now();
    $('resumeBtn').hidden = !paused;
    document.querySelectorAll('[data-pause]').forEach((b) => (b.hidden = !!paused));
    $('stateLine').textContent = paused ? '⏸ ' + fmtPaused(state.pausedUntil) : '';

    const match = host ? SB.findMatch(url, state.sites || []) : null;
    const btn = $('toggleBtn');
    btn.disabled = !host;
    btn.textContent = match ? 'Unblock this site' : 'Block this site';
    btn.dataset.match = match || '';
    btn.dataset.host = host;

    $('statsLine').textContent =
      state.totalBlocks > 0 ? `Blocked ${state.totalBlocks} time${state.totalBlocks === 1 ? '' : 's'} • ${state.sites.length} site(s) on list` : `${state.sites.length} site(s) on list`;
  }

  document.addEventListener('DOMContentLoaded', () => {
    refresh();

    $('toggleBtn').addEventListener('click', async () => {
      const btn = $('toggleBtn');
      const host = btn.dataset.host;
      if (!host) return;
      $('msg').textContent = '';
      if (btn.dataset.match) {
        const r = await send({ type: 'removeSite', pattern: btn.dataset.match });
        $('msg').textContent = r && r.ok ? 'Unblocked ✓' : (r && r.error) || 'Failed.';
      } else {
        const r = await send({ type: 'addSite', pattern: host });
        $('msg').textContent = r && r.ok ? `Blocked ${r.pattern} ✓` : (r && r.error) || 'Failed.';
      }
      refresh();
    });

    document.querySelectorAll('[data-pause]').forEach((b) => {
      b.addEventListener('click', async () => {
        const mins = Number(b.dataset.pause);
        await send({ type: 'setPaused', pausedUntil: Date.now() + mins * 60000 });
        $('msg').textContent = `Paused for ${mins}m. Focus later, not never.`;
        refresh();
      });
    });

    $('resumeBtn').addEventListener('click', async () => {
      await send({ type: 'setPaused', pausedUntil: 0 });
      $('msg').textContent = 'Blocking resumed ✓';
      refresh();
    });

    const open = (e) => {
      e.preventDefault();
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else chrome.tabs.create({ url: chrome.runtime.getURL('html/options.html') });
    };
    $('openOptions').addEventListener('click', open);
    $('optionsBtn').addEventListener('click', open);
  });
})();
