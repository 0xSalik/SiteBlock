chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.sync.set({ blockedWebsites: [] });
});

chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  chrome.storage.sync.get(["blockedWebsites"], function (result) {
    const blockedWebsites = result.blockedWebsites || [];
    const blockedUrl = blockedWebsites.find((website) =>
      details.url.includes(website)
    );

    if (blockedUrl) {
      chrome.webNavigation.onBeforeNavigate.removeListener(handleNavigation);
      chrome.tabs.update(details.tabId, { url: "html/blocked.html" });
    }
  });
});

function handleNavigation(details) {
  chrome.webNavigation.onBeforeNavigate.removeListener(handleNavigation);
}
