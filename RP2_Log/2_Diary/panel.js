// panel.js - Toolbar popup for CAPTCHA Diary
// Shows current tab's most recent session, or watching/no-consent state.

let currentBlobUrl = null;

function showState(stateId) {
  for (const id of ["state-loading", "state-no-consent", "state-watching", "state-session"]) {
    document.getElementById(id).classList.toggle("hidden", id !== stateId);
  }
}

function setHeaderStatus(text, type) { // type: "watching" | "recording" | null
  const el = document.getElementById("header-status");
  if (!text) { el.classList.add("hidden"); return; }
  el.textContent = text;
  el.className = `header-status ${type || "watching"}`;
  el.classList.remove("hidden");
}

function formatTimeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDuration(ms) {
  if (!ms) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function providerLabel(provider) {
  const map = {
    recaptcha: "reCAPTCHA",
    hcaptcha: "hCaptcha",
    cloudflare: "Turnstile",
    geetest: "GeeTest",
    arkose: "Arkose",
    datadome: "DataDome",
    perimeterx: "PerimeterX",
    slider: "Slider",
    unknown: "CAPTCHA"
  };
  return map[provider] || "CAPTCHA";
}

async function init() {
  // Get active tab
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) { showState("state-loading"); return; }

  // Update header with hostname
  const hostname = tab.url ? new URL(tab.url).hostname : "—";
  document.getElementById("header-title").textContent = hostname || "CAPTCHA Diary";

  // Check consent
  let consentResp;
  try {
    consentResp = await browser.runtime.sendMessage({ action: "check-consent", windowId: tab.windowId });
  } catch (e) {
    showState("state-no-consent");
    return;
  }

  if (!consentResp || !consentResp.consented) {
    showState("state-no-consent");
    return;
  }

  setHeaderStatus("Watching", "watching");

  // Get popup data for this tab
  let data;
  try {
    data = await browser.runtime.sendMessage({ action: "get-popup-data", tabId: tab.id });
  } catch (e) {
    data = { recentSession: null, totalSessions: 0 };
  }

  // Footer count
  const countEl = document.getElementById("footer-count");
  if (data.totalSessions === 0) {
    countEl.textContent = "No sessions yet";
  } else {
    countEl.textContent = `${data.totalSessions} session${data.totalSessions !== 1 ? "s" : ""} in archive`;
  }

  // Show "View Archive" if there are any sessions
  if (data.totalSessions > 0) {
    document.getElementById("view-archive-btn").classList.remove("hidden");
  }

  if (!data.recentSession) {
    showState("state-watching");
    return;
  }

  // State C: show session preview
  const session = data.recentSession;

  document.getElementById("meta-provider").textContent = providerLabel(session.provider);
  document.getElementById("meta-images").textContent = `${session.imageCount} image${session.imageCount !== 1 ? "s" : ""}`;
  document.getElementById("meta-rounds").textContent = `${session.rounds} round${session.rounds !== 1 ? "s" : ""}`;

  const detail = `${formatTimeAgo(session.savedAt)} · ${formatDuration(session.duration)} · ${session.cursorPointCount} cursor pts`;
  document.getElementById("meta-detail").textContent = detail;

  // Try to load first image as thumbnail
  const firstImageId = `${session.sessionId}-img-000`;
  try {
    const imgResp = await browser.runtime.sendMessage({ action: "get-image", imageId: firstImageId });
    if (imgResp && imgResp.image && imgResp.image.blob) {
      currentBlobUrl = URL.createObjectURL(imgResp.image.blob);
      const imgEl = document.getElementById("preview-img");
      imgEl.src = currentBlobUrl;
      imgEl.classList.remove("hidden");
      document.getElementById("preview-placeholder").classList.add("hidden");
    }
  } catch (e) {}

  showState("state-session");
}

// View Archive button
document.getElementById("view-archive-btn").addEventListener("click", () => {
  browser.runtime.sendMessage({ action: "open-sidebar" });
  window.close();
});

// Grant Consent button
document.getElementById("grant-consent-btn").addEventListener("click", async () => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab) {
    await browser.tabs.create({
      url: browser.runtime.getURL("consent.html"),
      windowId: tab.windowId
    });
  }
  window.close();
});

// Revoke blob URL when popup closes
window.addEventListener("unload", () => {
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
});

init();
