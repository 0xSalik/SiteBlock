/* Blocked-page logic: shows what was blocked, offers back / temp-allow. */
(function () {
  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  const QUOTES = [
    '“You can do anything, but not everything.” — David Allen',
    '“Focus is a matter of deciding what not to do.” — John Carmack',
    '“Starve your distractions, feed your focus.”',
    '“Small disciplined steps beat distracted sprints.”',
    '“Your future self is watching. Make them proud.”',
  ];

  function param(name) {
    try { return new URL(window.location.href).searchParams.get(name) || ''; }
    catch (e) { return ''; }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('quote').textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];

    // Prefer explicit ?u= param (navigation fallback), else lastBlocked from DNR path.
    let blockedUrl = param('u');
    let pattern = param('p');
    if (!blockedUrl) {
      const s = await send({ type: 'getState' });
      if (s && s.ok && s.lastBlocked) {
        blockedUrl = s.lastBlocked.url || '';
        pattern = pattern || s.lastBlocked.pattern || '';
      }
    }
    $('blockedUrl').textContent = blockedUrl || '';
    if (pattern) $('patternLine').textContent = `Matched rule: ${pattern}`;

    $('backBtn').addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.replace('about:blank');
    });
    $('manageBtn').addEventListener('click', () => {
      if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      else window.location.href = chrome.runtime.getURL('html/options.html');
    });
    $('allowBtn').addEventListener('click', async () => {
      if (!blockedUrl) return;
      const r = await send({ type: 'tempAllow', url: blockedUrl, minutes: 5 });
      if (r && r.ok) window.location.replace(blockedUrl);
      else $('patternLine').textContent = (r && r.error) || 'Could not allow temporarily.';
    });
  });
})();
