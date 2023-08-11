chrome.storage.sync.get(["blockedWebsites"], function (result) {
  const blockedWebsites = result.blockedWebsites || [];

  if (blockedWebsites.length > 0) {
    const currentUrl = window.location.href;

    for (const website of blockedWebsites) {
      if (currentUrl.includes(website)) {
        window.location.href = chrome.runtime.getURL("html/blocked.html");
        break;
      }
    }
  }
});
