chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  const url = new URL(details.url);
  const hostname = url.hostname;

  chrome.storage.sync.get(["blockedWebsites"], function (result) {
    const blockedWebsites = result.blockedWebsites || [];

    if (blockedWebsites.some((website) => hostname.includes(website))) {
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL("html/blocked.html"),
      });
    }
  });
});
