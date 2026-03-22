// consent.js - Per-window, per-session consent gate
// Sends consent decision back to background via message (not storage.local).
// Background holds consent state in memory; resets on browser restart.

(async () => {
  const statusEl = document.getElementById("status");

  // Get the windowId for this consent page's window
  let windowId = null;
  try {
    const tab = await browser.tabs.getCurrent();
    windowId = tab.windowId;
  } catch (e) {
    console.error("[DIARY] consent.js: could not get current tab", e);
  }

  document.getElementById("accept-btn").addEventListener("click", async () => {
    await browser.runtime.sendMessage({
      action: "consent-response",
      granted: true,
      windowId
    });
    statusEl.textContent = "Consent granted. CAPTCHA Diary is now active in this window.";
    statusEl.style.display = "block";
    statusEl.style.color = "#16a34a";
    setTimeout(() => window.close(), 1400);
  });

  document.getElementById("decline-btn").addEventListener("click", async () => {
    await browser.runtime.sendMessage({
      action: "consent-response",
      granted: false,
      windowId
    });
    statusEl.textContent = "Declined. CAPTCHA Diary will not monitor this window.";
    statusEl.style.display = "block";
    statusEl.style.color = "#b45309";
    setTimeout(() => window.close(), 1400);
  });
})();
