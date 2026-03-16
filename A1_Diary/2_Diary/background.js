// background.js - CAPTCHA Diary background script
// Handles: watched tab tracking, per-window consent, network image capture,
//          IndexedDB session saves, badge management, sidebar port, JSZip export.
// Requires db.js to be loaded first (listed before this in manifest.json scripts).

// ============================================
// Extension Run Identity
// ============================================
// Generated once per background-script load (i.e. once per extension start/reload).
// Stored on every session record so the sidebar can group recordings that were
// collected in the same extension run into a single collapsible panel.
const EXTENSION_RUN_ID = crypto.randomUUID().slice(0, 8);

// ============================================
// State
// ============================================

// Captured CAPTCHA images per tab (in-memory buffer, cleared after save)
let capturedImages = {};
const MAX_IMAGES_PER_TAB = 200;

// Aggregated cursor points per tab (in-memory, cleared after save)
let aggregatedCursorPoints = {};
const MAX_CURSOR_POINTS = 50000;

// Aggregated CAPTCHA elements per tab (in-memory, cleared after save)
let aggregatedCaptchaElements = {};


// Tabs the user has visited this session (append-only; tabs stay in set after user leaves)
let watchedTabs = new Set();

// Per-window consent state (in-memory; resets on browser restart = per-session)
let consentedWindows = new Set();

// Windows where the user explicitly declined consent — never re-prompt these.
let declinedWindows = new Set();

// Windows that already have a consent tab open (prevents the feedback loop where
// opening a consent tab fires tabs.onActivated → opens another consent tab → ∞)
let pendingConsentWindows = new Set();

// Maps consent tab ID → windowId, so we can clear pendingConsentWindows if the
// user closes the consent tab without responding
const consentTabs = new Map();

// Persistent port to sidebar (null when sidebar is closed)
let sidebarPort = null;

// Quick lookup: most recent sessionId per tab (for popup preview)
let lastSessionByTab = {};

// Last known page URL per tab — stored at capture time so flushSessionForTab
// can use it even after the tab is already closed.
let tabUrls = {};

// Deduplication: track last save per tab to prevent double-saves.
// Two separate guards:
//   1. Same recordedAt (recording start timestamp) — definitively the same encounter
//      regardless of how much time elapsed between saves.
//   2. Same hostname within 15s — catches rapid double-fires from overlapping
//      triggers when recordedAt isn't available (e.g. flushSessionForTab paths).
let lastSaveByTab = {}; // tabId → { at: timestamp, hostname: string, recordedAt: string|null }

// ============================================
// Consent Flow
// ============================================

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Open consent for the current window on fresh install
    browser.windows.getCurrent().then(w => checkAndGrantConsent(w.id));
  }
});

function checkAndGrantConsent(windowId) {
  if (consentedWindows.has(windowId)) return;
  if (declinedWindows.has(windowId)) return;       // user already declined — never re-prompt
  if (pendingConsentWindows.has(windowId)) return; // consent tab already open
  pendingConsentWindows.add(windowId);
  browser.tabs.create({
    url: browser.runtime.getURL("consent.html"),
    windowId
  }).then(tab => {
    consentTabs.set(tab.id, windowId);
  }).catch(() => {
    pendingConsentWindows.delete(windowId);
  });
}

// ============================================
// Sidebar Port
// ============================================

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "sidebar") {
    console.log("[DIARY] Sidebar port connected");
    sidebarPort = port;
    port.onDisconnect.addListener(() => {
      console.log("[DIARY] Sidebar port disconnected");
      sidebarPort = null;
    });

    // Replay recording-active for any tabs already in progress when sidebar connects.
    // This handles the case where the sidebar was opened after the first image was
    // captured (so the original recording-active message was never received).
    for (const [tabIdStr, imgs] of Object.entries(capturedImages)) {
      if (imgs.length > 0) {
        const tabId = parseInt(tabIdStr, 10);
        browser.tabs.get(tabId).then(tab => {
          let hostname = "";
          try { hostname = new URL(tab.url).hostname; } catch {}
          port.postMessage({ action: "recording-active", tabId, hostname });
        }).catch(() => {
          // Tab may have closed between capture and sidebar connect.
          // Use the stored URL (set at capture time) as fallback.
          const storedUrl = tabUrls[tabId] || "";
          let hostname = "";
          try { hostname = new URL(storedUrl).hostname; } catch {}
          if (hostname) port.postMessage({ action: "recording-active", tabId, hostname });
        });
      }
    }

    // Handle sidebar requests via port messages
    port.onMessage.addListener(async (message) => {
      if (message.action === "get-sessions") {
        const sessions = await db.getSessions(message.offset || 0, message.limit || 20, message.filter || {});
        port.postMessage({ action: "sessions-result", requestId: message.requestId, sessions });
      }
      if (message.action === "get-archive-stats") {
        const stats = await db.getArchiveMeta();
        port.postMessage({ action: "archive-stats-result", requestId: message.requestId, stats });
      }
      if (message.action === "get-filter-options") {
        const [hostnames, providers] = await Promise.all([
          db.getDistinctHostnames(),
          db.getDistinctProviders()
        ]);
        port.postMessage({ action: "filter-options-result", requestId: message.requestId, hostnames, providers });
      }
    });
  }
});

function notifySidebar(action, payload) {
  if (!sidebarPort) {
    console.log(`[DIARY] notifySidebar("${action}") skipped — sidebarPort is null`);
    return;
  }
  try {
    sidebarPort.postMessage({ action, ...payload });
    console.log(`[DIARY] notifySidebar("${action}") sent`);
  } catch (e) {
    console.log(`[DIARY] notifySidebar("${action}") failed:`, e.message);
    sidebarPort = null;
  }
}

// ============================================
// Tab / Window Tracking
// ============================================

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!consentedWindows.has(windowId)) {
    checkAndGrantConsent(windowId);
    return;
  }
  if (watchedTabs.has(tabId)) return;

  // New tab being visited for the first time this session
  watchedTabs.add(tabId);
  capturedImages[tabId] = capturedImages[tabId] || [];
  aggregatedCursorPoints[tabId] = aggregatedCursorPoints[tabId] || [];
  aggregatedCaptchaElements[tabId] = aggregatedCaptchaElements[tabId] || [];

  browser.tabs.sendMessage(tabId, { action: "you-are-watched" }).catch(() => {});
});

browser.windows.onCreated.addListener((window) => {
  // Every new window requires fresh consent
  checkAndGrantConsent(window.id);
});

// Clean up when tab closes; flush any in-progress session first
browser.tabs.onRemoved.addListener(async (tabId) => {
  // If this was a consent tab closed without responding, unblock that window
  if (consentTabs.has(tabId)) {
    pendingConsentWindows.delete(consentTabs.get(tabId));
    consentTabs.delete(tabId);
    return; // consent tabs have no session data, nothing else to clean up
  }
  const hasImages = (capturedImages[tabId] || []).length > 0;
  const hasCursors = (aggregatedCursorPoints[tabId] || []).length > 0;

  if (hasImages || hasCursors) {
    // Await so cleanup runs AFTER flush reads capturedImages/cursors
    await flushSessionForTab(tabId, "tab-close");
  }

  // Always notify sidebar — covers cases where flush was skipped or
  // recording-active was sent but no save occurred (e.g. empty session)
  notifySidebar("recording-ended", { tabId });

  watchedTabs.delete(tabId);
  delete capturedImages[tabId];
  delete aggregatedCursorPoints[tabId];
  delete aggregatedCaptchaElements[tabId];
  delete lastSessionByTab[tabId];
  delete tabUrls[tabId];
});

// ============================================
// Message Handling
// ============================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // --- Consent ---

  if (message.action === "consent-response") {
    // Clear the pending flag regardless of accept/decline
    if (message.windowId != null) {
      pendingConsentWindows.delete(message.windowId);
      // Clear the consentTabs entry for this window
      for (const [tabId, wId] of consentTabs) {
        if (wId === message.windowId) consentTabs.delete(tabId);
      }
    }
    if (!message.granted && message.windowId != null) {
      declinedWindows.add(message.windowId);
    }
    if (message.granted && message.windowId != null) {
      consentedWindows.add(message.windowId);
      // Register all currently open tabs in this window as watched, and notify them.
      // This is the moment the user grants consent — all open tabs should start monitoring.
      browser.tabs.query({ windowId: message.windowId }).then(tabs => {
        for (const tab of tabs) {
          if (tab.id != null && !consentTabs.has(tab.id)) { // skip the consent tab itself
            if (!watchedTabs.has(tab.id)) {
              watchedTabs.add(tab.id);
              capturedImages[tab.id] = capturedImages[tab.id] || [];
              aggregatedCursorPoints[tab.id] = aggregatedCursorPoints[tab.id] || [];
              aggregatedCaptchaElements[tab.id] = aggregatedCaptchaElements[tab.id] || [];
            }
            browser.tabs.sendMessage(tab.id, {
              action: "consent-granted",
              windowId: message.windowId
            }).catch(() => {});
          }
        }
      });
    }
    return;
  }

  if (message.action === "check-consent") {
    // message.windowId is supplied by the popup (which has no sender.tab);
    // content scripts supply it via sender.tab.
    const resolveConsent = (windowId) => {
      const consented = consentedWindows.has(windowId);
      // If consented and this is a real tab (content script)s, register it as watched now.
      // This covers the case where tabs.onActivated hasn't fired yet for this tab.
      if (consented && tabId != null && !watchedTabs.has(tabId)) {
        watchedTabs.add(tabId);
        capturedImages[tabId] = capturedImages[tabId] || [];
        aggregatedCursorPoints[tabId] = aggregatedCursorPoints[tabId] || [];
        aggregatedCaptchaElements[tabId] = aggregatedCaptchaElements[tabId] || [];
      }
      sendResponse({ consented });
    };

    if (message.windowId != null) {
      resolveConsent(message.windowId);
    } else {
      browser.tabs.get(tabId)
        .then(tab => resolveConsent(tab.windowId))
        .catch(() => sendResponse({ consented: false }));
    }
    return true;
  }

  // --- Tab watch state (content script asking on load) ---

  if (message.action === "check-watched") {
    sendResponse({ watched: watchedTabs.has(tabId) });
    return true;
  }

  // --- Cursor points ---

  if (message.action === "cursor-point" && tabId) {
    if (!aggregatedCursorPoints[tabId]) aggregatedCursorPoints[tabId] = [];
    aggregatedCursorPoints[tabId].push(message.point);
    if (aggregatedCursorPoints[tabId].length > MAX_CURSOR_POINTS) {
      aggregatedCursorPoints[tabId] = aggregatedCursorPoints[tabId].slice(-MAX_CURSOR_POINTS);
    }
  }

  // --- CAPTCHA elements ---

  if (message.action === "captcha-elements" && tabId) {
    if (!aggregatedCaptchaElements[tabId]) aggregatedCaptchaElements[tabId] = [];
    const existingKeys = new Set(
      aggregatedCaptchaElements[tabId].map(e => `${e.frameId}:${e.selector}`)
    );
    for (const el of message.elements) {
      const key = `${el.frameId}:${el.selector}`;
      if (!existingKeys.has(key)) {
        aggregatedCaptchaElements[tabId].push(el);
        existingKeys.add(key);
      }
    }
  }


  // --- Inline CAPTCHA images (DOM extraction) ---

  if (message.action === "captcha-inline-images" && tabId) {
    if (!capturedImages[tabId]) capturedImages[tabId] = [];
    const prevCount = capturedImages[tabId].length;

    for (const img of message.images) {
      const urlKey = img.dataUrl.substring(0, 200);
      const exists = capturedImages[tabId].some(
        existing => existing.dataUrl.substring(0, 200) === urlKey
      );
      if (!exists) {
        const mimeMatch = img.dataUrl.match(/^data:([^;,]+)/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
        capturedImages[tabId].push({
          timestamp: img.timestamp,
          url: `inline:${img.type}:${img.selector}`,
          size: Math.round(img.dataUrl.length * 0.75),
          mimeType,
          dataUrl: img.dataUrl,
          source: "dom-extraction",
          extractionType: img.type,
          width: img.width,
          height: img.height,
          captchaSelector: img.captchaSelector,
          frameId: img.frameId
        });
      }
    }

    if (capturedImages[tabId].length > MAX_IMAGES_PER_TAB) {
      capturedImages[tabId] = capturedImages[tabId].slice(-MAX_IMAGES_PER_TAB);
    }

    // Notify sidebar of first recording activity (DOM-extraction path).
    // Mirrors the same notification in the webRequest interception path.
    // Also store the tab URL so flushSessionForTab can use it even after
    // the tab is already closed (same as the webRequest path does).
    if (prevCount === 0 && capturedImages[tabId].length > 0) {
      browser.tabs.get(tabId).then(tab => {
        tabUrls[tabId] = tab.url || "";
        let hostname = "";
        try { hostname = new URL(tab.url).hostname; } catch {}
        notifySidebar("recording-active", { tabId, hostname });
      }).catch(() => {});
    }

    browser.tabs.sendMessage(tabId, {
      action: "captcha-image-captured",
      imageCount: capturedImages[tabId].length
    }).catch(() => {});
  }

  // --- CAPTCHA appeared (badge on) ---

  if (message.action === "captcha-appeared" && tabId && message.isTopFrame) {
    browser.browserAction.setBadgeText({ text: "●", tabId });
    browser.browserAction.setBadgeBackgroundColor({ color: "#DC2626", tabId });
  }

  // --- CAPTCHA disappeared (badge off) ---

  if (message.action === "captcha-disappeared" && tabId && message.isTopFrame) {
    browser.browserAction.setBadgeText({ text: "", tabId });
  }

  // --- Recording badge (kept for compatibility with existing startRecording/stopRecording) ---

  if (message.action === "recording-started" && message.isTopFrame && tabId) {
    browser.browserAction.setBadgeText({ text: "●", tabId });
    browser.browserAction.setBadgeBackgroundColor({ color: "#DC2626", tabId });
  }
  if (message.action === "recording-stopped" && message.isTopFrame && tabId) {
    browser.browserAction.setBadgeText({ text: "", tabId });
  }

  // --- Aggregated data for export ---

  if (message.action === "get-aggregated-data" && tabId) {
    const points = (aggregatedCursorPoints[tabId] || []).sort((a, b) => a.t - b.t);
    sendResponse({
      cursorPoints: points,
      captchaElements: aggregatedCaptchaElements[tabId] || []
    });
    return true;
  }

  if (message.action === "clear-cursor-data" && tabId) {
    aggregatedCursorPoints[tabId] = [];
    aggregatedCaptchaElements[tabId] = [];
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "get-captured-images") {
    sendResponse({ images: capturedImages[tabId] || [] });
    return true;
  }

  if (message.action === "clear-images") {
    capturedImages[tabId] = [];
    sendResponse({ success: true });
    return true;
  }

  // --- Save session (replaces export-session) ---

  if (message.action === "save-session") {
    saveSession(tabId, message.data)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // --- Popup requests ---

  if (message.action === "get-popup-data") {
    const queryTabId = message.tabId || tabId;
    getPopupData(queryTabId)
      .then(data => {
        data.hasActiveImages = (capturedImages[queryTabId] || []).length > 0;
        sendResponse(data);
      })
      .catch(() => sendResponse({ recentSession: null, totalSessions: 0, hasActiveImages: false }));
    return true;
  }

  if (message.action === "manual-flush") {
    const queryTabId = message.tabId || tabId;
    flushSessionForTab(queryTabId, "manual")
      .then(() => {
        browser.browserAction.setBadgeText({ text: "", tabId: queryTabId }).catch(() => {});
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "open-sidebar") {
    browser.sidebarAction.open().catch(() => {});
  }

  // --- Sidebar sendMessage requests (for operations that need a response) ---

  if (message.action === "get-session-detail") {
    db.getSession(message.sessionId)
      .then(session => sendResponse({ session }))
      .catch(() => sendResponse({ session: null }));
    return true;
  }

  if (message.action === "get-image") {
    db.getImage(message.imageId)
      .then(image => sendResponse({ image }))
      .catch(() => sendResponse({ image: null }));
    return true;
  }

  if (message.action === "get-images-for-session") {
    db.getImagesForSession(message.sessionId)
      .then(images => sendResponse({ images }))
      .catch(() => sendResponse({ images: [] }));
    return true;
  }

  if (message.action === "get-cursors") {
    db.getCursors(message.sessionId)
      .then(result => sendResponse({ cursors: result }))
      .catch(() => sendResponse({ cursors: null }));
    return true;
  }

  if (message.action === "update-session-notes") {
    db.updateSessionNotes(message.sessionId, message.notes)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "delete-session") {
    db.deleteSession(message.sessionId)
      .then(() => {
        notifySidebar("session-deleted", { sessionId: message.sessionId });
        sendResponse({ success: true });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "export-zip") {
    exportZip(message.sessionIds).catch(err => {
      console.error("[DIARY] ZIP export failed:", err);
    });
  }

  if (message.action === "export-zip-flat") {
    exportZipFlat(message.sessionIds).catch(err => {
      console.error("[DIARY] Flat ZIP export failed:", err);
    });
  }

  if (message.action === "get-archive-stats") {
    db.getArchiveMeta()
      .then(stats => sendResponse({ stats }))
      .catch(() => sendResponse({ stats: null }));
    return true;
  }
});

// ============================================
// CAPTCHA Image Capture (network interception)
// ============================================

function detectMimeFromBytes(bytes) {
  if (bytes.length < 8) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp";
  return null;
}

const CAPTCHA_IMAGE_PATTERNS = [
  "*://*.google.com/recaptcha/*/payload*",
  "*://*.google.com/recaptcha/api2/payload*",
  "*://*.google.com/recaptcha/enterprise/payload*",
  "*://*.recaptcha.net/recaptcha/*/payload*",  // recaptcha.net mirror (used in some regions/configs)
  "*://recaptcha.net/recaptcha/*/payload*",
  "*://*.hcaptcha.com/captcha/*",
  "*://imgs.hcaptcha.com/*",
  "*://imgs2.hcaptcha.com/*",   // HAR shows grid images sometimes served from imgs2.*
  "*://imgs3.hcaptcha.com/*",   // HAR confirms: all 9 task grid images come from imgs3.*
  "*://newassets.hcaptcha.com/*",
  "*://api2.hcaptcha.com/*",
  "*://challenges.cloudflare.com/cdn-cgi/*",
  "*://*.geetest.com/get.php*",
  "*://*.geetest.com/ajax.php*",
  "*://*.geetest.com/static/*",          // GeeTest v3 static assets
  "*://static.geetest.com/captcha_v4/*", // GeeTest v4 challenge images (phrase, icon, slider)
  "*://api.geetest.com/*",
  "*://*.arkoselabs.com/fc/assets/*",
  "*://*.funcaptcha.com/fc/assets/*",
  "*://client-api.arkoselabs.com/fc/assets/*",
  "*://dd.datadome.co/captcha/*",
  "*://*.perimeterx.net/captcha/*",
  "*://*.px-cdn.net/captcha/*"
];

// Provider detection from URL
const PROVIDER_PATTERNS = [
  { pattern: /google\.com\/recaptcha/, provider: "recaptcha" },
  { pattern: /recaptcha\.net/, provider: "recaptcha" },
  { pattern: /hcaptcha\.com/, provider: "hcaptcha" },
  { pattern: /imgs\.hcaptcha\.com/, provider: "hcaptcha" },
  { pattern: /challenges\.cloudflare\.com/, provider: "cloudflare" },
  { pattern: /geetest\.com/, provider: "geetest" },
  { pattern: /arkoselabs\.com|funcaptcha\.com/, provider: "arkose" },
  { pattern: /datadome\.co/, provider: "datadome" },
  { pattern: /perimeterx\.net|px-cdn\.net/, provider: "perimeterx" }
];

function detectProvider(url, captchaElements) {
  if (url) {
    for (const { pattern, provider } of PROVIDER_PATTERNS) {
      if (pattern.test(url)) return provider;
    }
  }
  if (captchaElements && captchaElements.length > 0) {
    const src = captchaElements[0].src || captchaElements[0].frameUrl || "";
    for (const { pattern, provider } of PROVIDER_PATTERNS) {
      if (pattern.test(src)) return provider;
    }
    const selector = captchaElements[0].selector || "";
    if (/recaptcha/i.test(selector)) return "recaptcha";
    if (/hcaptcha/i.test(selector)) return "hcaptcha";
    if (/geetest/i.test(selector)) return "geetest";
    if (/arkose|funcaptcha/i.test(selector)) return "arkose";
    if (/slider/i.test(selector)) return "slider";
  }
  return "unknown";
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only capture for watched tabs
    if (details.tabId < 0 || !watchedTabs.has(details.tabId)) return;
    // Allow both direct image requests and XHR/fetch-loaded images (hCaptcha fetches
    // challenge tiles via XHR before drawing to canvas, so type is "xmlhttprequest").
    // Magic-byte detection in onstop filters out non-image responses.
    if (!["image", "xmlhttprequest"].includes(details.type)) return;

    try {
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const chunks = [];

      filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data);
      };

      filter.onstop = () => {
        filter.close();

        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }

        const mimeType = detectMimeFromBytes(combined);
        if (!mimeType) return;
        if (combined.length < 1000) return;

        let binary = "";
        for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
        const base64 = btoa(binary);

        const imageEntry = {
          timestamp: new Date().toISOString(),
          url: details.url,
          size: combined.length,
          mimeType,
          dataUrl: `data:${mimeType};base64,${base64}`
        };

        if (!capturedImages[details.tabId]) capturedImages[details.tabId] = [];
        capturedImages[details.tabId].push(imageEntry);

        // Notify sidebar that recording has started (first image for this tab).
        // Also store the tab URL now so flushSessionForTab can use it even
        // after the tab is already closed (browser.tabs.get would throw then).
        if (capturedImages[details.tabId].length === 1) {
          browser.tabs.get(details.tabId).then(tab => {
            tabUrls[details.tabId] = tab.url || "";
            let hostname = "";
            try { hostname = new URL(tab.url).hostname; } catch {}
            notifySidebar("recording-active", { tabId: details.tabId, hostname });
          }).catch(() => {});
        }

        // Scene capture: take a tab screenshot 600ms after the FIRST image is captured.
        // This gives a visual record of what the CAPTCHA looked like in context.
        if (capturedImages[details.tabId].length === 1) {
          setTimeout(() => {
            browser.tabs.get(details.tabId)
              .then(tab => browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 }))
              .then(dataUrl => {
                capturedImages[details.tabId].unshift({
                  timestamp: new Date().toISOString(),
                  url: `scene-capture:${details.tabId}:${Date.now()}`,
                  size: dataUrl.length,
                  mimeType: "image/jpeg",
                  dataUrl,
                  isSceneCapture: true
                });
              })
              .catch(() => {}); // silently skip if tab not active or permission fails
          }, 600);
        }

        if (capturedImages[details.tabId].length > MAX_IMAGES_PER_TAB) {
          capturedImages[details.tabId] = capturedImages[details.tabId].slice(-MAX_IMAGES_PER_TAB);
        }

        browser.tabs.sendMessage(details.tabId, {
          action: "captcha-image-captured",
          imageCount: capturedImages[details.tabId].length
        }).catch(() => {});

        console.log(`[DIARY] Captured ${mimeType}: ${combined.length} bytes`);
      };

      filter.onerror = () => { filter.close(); };
    } catch (e) {}
  },
  { urls: CAPTCHA_IMAGE_PATTERNS },
  ["blocking"]
);

// ============================================
// Session Save (replaces exportSession)
// ============================================

function dataUrlToBlob(dataUrl) {
  const commaIdx = dataUrl.indexOf(",");
  const header = dataUrl.substring(0, commaIdx);
  const base64 = dataUrl.substring(commaIdx + 1);
  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function saveSession(tabId, sessionData) {
  const images = capturedImages[tabId] || [];
  const cursorPoints = (aggregatedCursorPoints[tabId] || []).sort((a, b) => a.t - b.t);

  if (images.length === 0 && cursorPoints.length === 0) {
    console.log("[DIARY] Skipping empty session save");
    return;
  }

  const hostname   = sessionData.hostname   || "";
  const recordedAt = sessionData.recordedAt || null;
  const prev = lastSaveByTab[tabId];
  if (prev) {
    // Guard 1: same recording start → same encounter, always dedup.
    if (recordedAt && prev.recordedAt && recordedAt === prev.recordedAt) {
      console.log(`[DIARY] Deduping save for ${hostname} — same recordedAt ${recordedAt}`);
      return;
    }
    // Guard 2: same hostname within 15s — catches rapid overlapping triggers.
    if (prev.hostname === hostname && (Date.now() - prev.at) < 15000) {
      console.log(`[DIARY] Deduping save for ${hostname} (${Date.now() - prev.at}ms since last)`);
      return;
    }
  }

  const sessionId = crypto.randomUUID();
  const provider = detectProvider(sessionData.sourceUrl, sessionData.captchaElements);

  const sessionRecord = {
    sessionId,
    extensionRunId: EXTENSION_RUN_ID,
    savedAt: new Date().toISOString(),
    recordedAt: sessionData.recordedAt || sessionData.savedAt || new Date().toISOString(),
    hostname: sessionData.hostname || "",
    sourceUrl: sessionData.sourceUrl || "",
    provider,
    duration: sessionData.duration || 0,
    rounds: sessionData.rounds || 1,
    imageCount: images.length,
    cursorPointCount: cursorPoints.length,
    viewport: sessionData.viewport || {},
    frames: sessionData.frames || [],
    captchaElements: (sessionData.captchaElements || []).map(c => ({
      selector: c.selector, rect: c.rect, promptText: c.promptText,
      tagName: c.tagName, src: c.src, frameId: c.frameId,
      frameUrl: c.frameUrl, frameDepth: c.frameDepth
    })),
    exportTrigger: sessionData.exportTrigger || "unknown",
    tabId,
    windowId: sessionData.windowId || null
  };

  await db.saveSession(sessionRecord);

  // Save cursor points separately (not inline in session record)
  if (cursorPoints.length > 0) {
    await db.saveCursors(sessionId, cursorPoints);
  }

  // Save each image as a Blob
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const imageId = `${sessionId}-img-${String(i).padStart(3, "0")}`;
    const blob = dataUrlToBlob(img.dataUrl);
    await db.saveImage({
      imageId,
      sessionId,
      index: i,
      timestamp: img.timestamp || new Date().toISOString(),
      url: img.url || "",
      mimeType: img.mimeType || "image/png",
      size: img.size || blob.size,
      width: img.width || null,
      height: img.height || null,
      source: img.source || "network",
      extractionType: img.extractionType || null,
      captchaSelector: img.captchaSelector || null,
      frameId: img.frameId || null,
      blob
    });
  }

  await db.updateArchiveMeta(1, images.length, cursorPoints.length);

  // Clear in-memory buffers
  capturedImages[tabId] = [];
  aggregatedCursorPoints[tabId] = [];
  aggregatedCaptchaElements[tabId] = [];

  lastSessionByTab[tabId] = sessionId;
  lastSaveByTab[tabId] = { at: Date.now(), hostname, recordedAt: recordedAt || null };

  console.log(`[DIARY] Session saved: ${sessionId} (${images.length} images, ${cursorPoints.length} cursor pts)`);

  // Notify sidebar (real-time update)
  notifySidebar("recording-ended", { tabId });
  notifySidebar("session-saved", { session: sessionRecord });
  const meta = await db.getArchiveMeta();
  notifySidebar("archive-stats-updated", { totalSessions: meta.totalSessions, totalImages: meta.totalImages });
}

async function flushSessionForTab(tabId, trigger) {
  const images = capturedImages[tabId] || [];
  const cursors = aggregatedCursorPoints[tabId] || [];
  if (images.length === 0 && cursors.length === 0) return;

  // Use the stored URL captured when the first image arrived.
  // Fall back to an empty string if tabs.get fails (tab already closed).
  let sourceUrl = tabUrls[tabId] || "";
  try {
    const tab = await browser.tabs.get(tabId);
    sourceUrl = tab.url || sourceUrl;
  } catch (e) {
    // Tab already gone — proceed with the stored URL.
  }

  let hostname = "";
  try { hostname = new URL(sourceUrl || "about:blank").hostname; } catch {}

  try {
    await saveSession(tabId, {
      hostname,
      sourceUrl,
      exportTrigger: trigger,
      rounds: 1,
      duration: cursors.length > 0 ? cursors[cursors.length - 1].t || 0 : 0,
      viewport: {},
      frames: [],
      captchaElements: aggregatedCaptchaElements[tabId] || []
    });
  } catch (e) {
    console.warn("[DIARY] Tab flush failed:", e.message);
  }
}

// ============================================
// Popup Data Helper
// ============================================

async function getPopupData(tabId) {
  const stats = await db.getArchiveMeta();
  const sessionId = lastSessionByTab[tabId];
  if (!sessionId) {
    return { recentSession: null, totalSessions: stats.totalSessions };
  }
  const session = await db.getSession(sessionId);
  return { recentSession: session, totalSessions: stats.totalSessions };
}

// ============================================
// JSZip Export
// ============================================

async function exportZip(sessionIds) {
  if (!sessionIds || sessionIds.length === 0) {
    // Export all: get all sessions
    const allSessions = await db.getSessions(0, 10000);
    sessionIds = allSessions.map(s => s.sessionId);
  }

  if (typeof JSZip === "undefined") {
    console.error("[DIARY] JSZip not loaded. Add jszip.min.js to background scripts.");
    return;
  }

  const zip = new JSZip();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  for (const sessionId of sessionIds) {
    const session = await db.getSession(sessionId);
    if (!session) continue;

    const folderName = `${session.hostname}-${session.savedAt.slice(0, 10)}-${sessionId.slice(0, 8)}`;
    const folder = zip.folder(folderName);

    // recording.json (without binary data)
    const sessionJson = JSON.stringify({ ...session }, null, 2);
    folder.file("recording.json", sessionJson);

    // Images
    const images = await db.getImagesForSession(sessionId);
    for (const img of images) {
      const ext = img.mimeType ? img.mimeType.split("/")[1] : "png";
      const filename = `img-${String(img.index).padStart(3, "0")}.${ext}`;
      folder.file(filename, img.blob);
    }

    // Cursors
    const cursors = await db.getCursors(sessionId);
    if (cursors && cursors.points) {
      folder.file("cursors.json", JSON.stringify(cursors.points, null, 2));
    }
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const zipUrl = URL.createObjectURL(zipBlob);

  await browser.downloads.download({
    url: zipUrl,
    filename: `captcha-diary-export-${timestamp}.zip`,
    saveAs: false
  });

  URL.revokeObjectURL(zipUrl);
  console.log(`[DIARY] ZIP exported: ${sessionIds.length} sessions`);
}

// ============================================
// JSZip Flat Export (all images in one folder, named by sessionId + timestamp)
// ============================================

async function exportZipFlat(sessionIds) {
  if (typeof JSZip === "undefined") {
    console.error("[DIARY] JSZip not loaded.");
    return;
  }

  const zip = new JSZip();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  for (const sessionId of sessionIds) {
    const session = await db.getSession(sessionId);
    if (!session) continue;

    // Format: yyyymmdd_HHMMSS (no colons, filesystem-safe)
    const dateStr = new Date(session.savedAt)
      .toISOString().replace("T", "_").replace(/:/g, "").slice(0, 15);
    const idShort = sessionId.slice(0, 8);

    const images = await db.getImagesForSession(sessionId);
    images.sort((a, b) => a.index - b.index);

    for (const img of images) {
      const ext = img.mimeType ? img.mimeType.split("/")[1] : "png";
      const idx = String(img.index).padStart(2, "0");
      const filename = `${idShort}_${dateStr}_${idx}.${ext}`;
      zip.file(filename, img.blob);
    }
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const zipUrl = URL.createObjectURL(zipBlob);

  await browser.downloads.download({
    url: zipUrl,
    filename: `captcha_images_flat_${timestamp}.zip`,
    saveAs: false
  });

  URL.revokeObjectURL(zipUrl);
  console.log(`[DIARY] Flat ZIP exported: ${sessionIds.length} sessions`);
}

// ============================================
// Startup
// ============================================

db.open()
  .then(() => console.log("[DIARY] IndexedDB ready"))
  .catch(err => console.error("[DIARY] IndexedDB failed:", err));

console.log("[DIARY] Background script loaded.");
