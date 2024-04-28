chrome.storage.sync.get(["blockedWebsites"], function (result) {
  const blockedWebsites = result.blockedWebsites || [];
  if (blockedWebsites.length > 0) {
    const currentUrl = window.location.href;
    const currentHostname = new URL(currentUrl).hostname;

    for (const website of blockedWebsites) {
      const pattern = new RegExp(`^(www\\.)?${website.replace(/\./g, "\\.")}$`);
      if (pattern.test(currentHostname)) {
        window.location.href = chrome.runtime.getURL("html/blocked.html");
        break;
      }
    }
  }
});
