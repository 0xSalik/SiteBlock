/* SiteBlock content-script fallback (runs at document_start).
 * DNR + webNavigation handle ~everything; this catches the remainder
 * (e.g. reader-mode / translated pages) without ever flashing content:
 * we ask the service worker whether this URL is blocked and bail out fast.
 */
(function () {
  try {
    const href = window.location.href;
    // Never interfere with our own pages or non-web schemes.
    if (!/^https?:\/\//i.test(href)) return;
    if (window.location.protocol === 'chrome-extension:') return;
    // Only act on the top frame.
    if (window.top !== window.self) return;

    chrome.runtime.sendMessage({ type: 'checkUrl', url: href }, (res) => {
      try {
        if (chrome.runtime.lastError) return;
        if (res && res.match) {
          // Stop the doomed page ASAP, then redirect without history entry.
          try { window.stop(); } catch (e) {}
          const target =
            chrome.runtime.getURL('html/blocked.html') +
            '?u=' + encodeURIComponent(href) +
            '&p=' + encodeURIComponent(res.match);
          window.location.replace(target);
        }
      } catch (e) {}
    });
  } catch (e) {}
})();
