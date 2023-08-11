document.addEventListener("DOMContentLoaded", function () {
  const blockedWebsitesTextarea = document.getElementById("blockedWebsites");
  const saveButton = document.getElementById("saveButton");

  chrome.storage.sync.get(["blockedWebsites"], function (result) {
    const blockedWebsites = result.blockedWebsites || [];
    blockedWebsitesTextarea.value = blockedWebsites.join("\n");
  });

  saveButton.addEventListener("click", function () {
    const blockedWebsites = blockedWebsitesTextarea.value
      .split("\n")
      .filter((website) => website.trim() !== "");
    chrome.storage.sync.set({ blockedWebsites }, function () {
      alert("Blocked websites saved!");
    });
  });
});
