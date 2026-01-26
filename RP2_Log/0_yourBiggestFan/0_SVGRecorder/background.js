// background.js - Handles toolbar button clicks
// This script runs in the extension's background context

browser.browserAction.onClicked.addListener((tab) => {
  // Send an "arm" message to activate spacebar control
  browser.tabs.sendMessage(tab.id, { action: "arm" });
});
