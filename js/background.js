chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  const url = new URL(details.url);
  const hostname = url.hostname;

  chrome.storage.sync.get(["blockedWebsites"], function (result) {
    const blockedWebsites = result.blockedWebsites || [];

    for (const website of blockedWebsites) {
      const pattern = new RegExp(`^(www\\.)?${website.replace(/\./g, "\\.")}$`);
      if (pattern.test(hostname)) {
        chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL("html/blocked.html"),
        });
        break;
      }
    }
  });
});
