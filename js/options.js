/* SiteBlock options page logic */
(function () {
  const $ = (id) => document.getElementById(id);
  const SB = window.SiteBlock;
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  let state = { sites: [], stats: {}, totalBlocks: 0, pausedUntil: 0 };

  function say(text, isErr) {
    const el = $('msg');
    el.textContent = text;
    el.style.color = isErr ? '#b3261e' : 'green';
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
  }

  function fmtPaused(until) {
    const ms = until - Date.now();
    if (ms <= 0) return 'Blocking is ON';
    const m = Math.ceil(ms / 60000);
    return m < 60 ? `⏸ Paused — resumes in ${m}m` : `⏸ Paused — resumes in ${(m / 60).toFixed(1)}h`;
  }

  function render() {
    const q = ($('search').value || '').toLowerCase();
    const list = $('siteList');
    list.innerHTML = '';
    const sites = [...(state.sites || [])].sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
    const shown = sites.filter((s) => !q || String(s.pattern).toLowerCase().includes(q));
    $('siteCount').textContent = String(sites.length);
    $('emptyNote').hidden = sites.length !== 0;

    for (const s of shown) {
      const li = document.createElement('li');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = s.enabled !== false;
      toggle.title = 'Enable/disable without deleting';
      toggle.addEventListener('change', async () => {
        await send({ type: 'toggleSite', id: s.id, enabled: toggle.checked });
        await reload(false);
      });
      const pat = document.createElement('span');
      pat.className = 'pat';
      pat.textContent = s.pattern;
      pat.style.opacity = s.enabled === false ? 0.45 : 1;
      const count = document.createElement('span');
      count.className = 'count';
      const n = (state.stats || {})[s.pattern] || 0;
      count.textContent = n ? `${n} hit${n === 1 ? '' : 's'}` : '';
      const del = document.createElement('button');
      del.textContent = 'Remove';
      del.addEventListener('click', async () => {
        await send({ type: 'removeSite', id: s.id, pattern: s.pattern });
        say(`Unblocked ${s.pattern}`);
        await reload(false);
      });
      li.append(toggle, pat, count, del);
      list.append(li);
    }

    $('pauseState').textContent = fmtPaused(state.pausedUntil || 0);
    $('statsLine').textContent = state.totalBlocks
      ? `You've dodged ${state.totalBlocks} distraction${state.totalBlocks === 1 ? '' : 's'} so far. Keep going 💪`
      : 'No blocks recorded yet.';
  }

  async function reload(rerender = true) {
    const r = await send({ type: 'getState' });
    if (r && r.ok) state = r;
    if (rerender) render();
    else render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    reload();

    const add = async () => {
      const raw = $('newSite').value;
      const norm = SB.normalize(raw);
      if (!SB.isValid(norm)) { say(`"${raw.trim()}" doesn't look like a valid site. Try facebook.com or *bet*.`, true); return; }
      const r = await send({ type: 'addSite', pattern: norm });
      if (r && r.ok) { $('newSite').value = ''; say(`Blocked ${r.pattern} ✓`); await reload(false); }
      else say((r && r.error) || 'Could not add site.', true);
    };
    $('addBtn').addEventListener('click', add);
    $('newSite').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    $('search').addEventListener('input', render);

    document.querySelectorAll('[data-pause]').forEach((b) => {
      b.addEventListener('click', async () => {
        const mins = Number(b.dataset.pause);
        await send({ type: 'setPaused', pausedUntil: Date.now() + mins * 60000 });
        say(`Paused for ${mins} minutes.`);
        await reload(false);
      });
    });
    $('resumeBtn').addEventListener('click', async () => {
      await send({ type: 'setPaused', pausedUntil: 0 });
      say('Blocking resumed ✓');
      await reload(false);
    });

    $('exportBtn').addEventListener('click', () => {
      const text = (state.sites || []).map((s) => s.pattern).join('\n');
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'siteblock-list.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    $('importToggle').addEventListener('click', () => {
      $('importBox').hidden = !$('importBox').hidden;
    });
    $('importConfirm').addEventListener('click', async () => {
      const lines = $('importText').value.split('\n');
      let added = 0, skipped = 0;
      for (const line of lines) {
        const norm = SB.normalize(line);
        if (!norm) continue;
        if (!SB.isValid(norm)) { skipped++; continue; }
        const r = await send({ type: 'addSite', pattern: norm });
        if (r && r.ok) added++; else skipped++;
      }
      $('importText').value = '';
      $('importBox').hidden = true;
      say(`Imported ${added} site(s)${skipped ? `, skipped ${skipped}` : ''}.`);
      await reload(false);
    });
    $('clearBtn').addEventListener('click', async () => {
      if (!confirm('Remove ALL blocked sites?')) return;
      for (const s of [...(state.sites || [])]) {
        await send({ type: 'removeSite', id: s.id, pattern: s.pattern });
      }
      say('List cleared.');
      await reload(false);
    });
  });
})();
