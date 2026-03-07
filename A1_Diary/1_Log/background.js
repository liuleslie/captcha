// background.js - CAPTCHA logger with frame-aware aggregation
// Handles: toolbar clicks, CAPTCHA image interception, cursor aggregation, ZIP export

// ============================================
// State
// ============================================

// Captured CAPTCHA images per tab: { tabId: [{timestamp, url, dataUrl, size}] }
let capturedImages = {};
const MAX_IMAGES_PER_TAB = 50;

// Aggregated cursor points per tab: { tabId: [{x, y, t, overCaptcha, frameId, frameUrl, frameDepth}] }
let aggregatedCursorPoints = {};
const MAX_CURSOR_POINTS = 50000;

// Aggregated CAPTCHA elements per tab: { tabId: [{selector, rect, ...}] }
let aggregatedCaptchaElements = {};

// Activated tabs (tracks top frames only)
let activatedTabs = new Set();

// ============================================
// Consent Flow
// ============================================

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.tabs.create({ url: browser.runtime.getURL("consent.html") });
  }
});

function openConsentPage() {
  browser.tabs.create({ url: browser.runtime.getURL("consent.html") });
}

// ============================================
// Toolbar Button
// ============================================

browser.browserAction.onClicked.addListener(async (tab) => {
  // Check consent before allowing activation
  const store = await browser.storage.local.get("consented");
  if (store.consented !== true) {
    openConsentPage();
    return;
  }

  // First, try to send message (content script may already be loaded)
  try {
    await browser.tabs.sendMessage(tab.id, { action: "toggle-activate" });
    return;
  } catch (err) {
    // Content script not loaded - inject it programmatically
    console.log("[CAPLOG] Content script not found, injecting...");
  }

  // Programmatically inject the content script (for temporary addons or new tabs)
  try {
    await browser.tabs.executeScript(tab.id, {
      file: "main.js",
      allFrames: true,
      runAt: "document_start"
    });

    // Wait for script to initialize
    await new Promise(r => setTimeout(r, 100));

    // Now send the activate message
    await browser.tabs.sendMessage(tab.id, { action: "toggle-activate" });
    console.log("[CAPLOG] Content script injected and activated");
  } catch (err) {
    console.warn("[CAPLOG] Failed to inject content script:", err.message);
    console.warn("[CAPLOG] Make sure you're on a regular web page (not about:, moz-extension:, etc.)");
  }
});

// ============================================
// Message Handling
// ============================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Activated state tracking (from top frame)
  if (message.action === "activated-state") {
    if (message.activated && message.isTopFrame) {
      activatedTabs.add(tabId);
      // Initialize/reset storage for this tab
      capturedImages[tabId] = [];
      aggregatedCursorPoints[tabId] = [];
      aggregatedCaptchaElements[tabId] = [];
      console.log(`[CAPLOG] Tab ${tabId} activated`);
    } else if (!message.activated && message.isTopFrame) {
      activatedTabs.delete(tabId);
      browser.browserAction.setBadgeText({ text: "", tabId }).catch(() => {});
      console.log(`[CAPLOG] Tab ${tabId} deactivated`);
    }
  }

  // Cursor point from any frame
  if (message.action === "cursor-point" && tabId) {
    if (!aggregatedCursorPoints[tabId]) {
      aggregatedCursorPoints[tabId] = [];
    }
    aggregatedCursorPoints[tabId].push(message.point);

    // Limit total points
    if (aggregatedCursorPoints[tabId].length > MAX_CURSOR_POINTS) {
      aggregatedCursorPoints[tabId] = aggregatedCursorPoints[tabId].slice(-MAX_CURSOR_POINTS);
    }
  }

  // CAPTCHA elements from any frame
  if (message.action === "captcha-elements" && tabId) {
    if (!aggregatedCaptchaElements[tabId]) {
      aggregatedCaptchaElements[tabId] = [];
    }
    // Merge elements, avoiding duplicates by frameId+selector
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

  // Inline CAPTCHA images from DOM (base64 images, canvas captures)
  // This handles CAPTCHAs that don't load images via network (e.g., Temu slider)
  if (message.action === "captcha-inline-images" && tabId) {
    if (!capturedImages[tabId]) {
      capturedImages[tabId] = [];
    }

    for (const img of message.images) {
      // Deduplicate by checking if we already have this image (by truncated dataUrl)
      const urlKey = img.dataUrl.substring(0, 200);
      const exists = capturedImages[tabId].some(
        existing => existing.dataUrl.substring(0, 200) === urlKey
      );

      if (!exists) {
        // Extract MIME type from data URL
        const mimeMatch = img.dataUrl.match(/^data:([^;,]+)/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/png";

        const imageEntry = {
          timestamp: img.timestamp,
          url: `inline:${img.type}:${img.selector}`,
          size: Math.round(img.dataUrl.length * 0.75), // Approximate decoded size
          mimeType: mimeType,
          dataUrl: img.dataUrl,
          source: "dom-extraction",
          extractionType: img.type, // 'inline-image', 'canvas', or 'background-image'
          width: img.width,
          height: img.height,
          captchaSelector: img.captchaSelector,
          frameId: img.frameId
        };

        capturedImages[tabId].push(imageEntry);
        console.log(`[CAPLOG] ✓ Captured ${img.type}: ${imageEntry.size} bytes from DOM`);
      }
    }

    // Limit images per tab
    if (capturedImages[tabId].length > MAX_IMAGES_PER_TAB) {
      capturedImages[tabId] = capturedImages[tabId].slice(-MAX_IMAGES_PER_TAB);
    }

    // Notify content script of image count update
    browser.tabs.sendMessage(tabId, {
      action: "captcha-image-captured",
      imageCount: capturedImages[tabId].length
    }).catch(() => {});
  }

  // Clear cursor data (after export)
  if (message.action === "clear-cursor-data" && tabId) {
    aggregatedCursorPoints[tabId] = [];
    aggregatedCaptchaElements[tabId] = [];
    sendResponse({ success: true });
    return true;
  }

  // Get aggregated data for export
  if (message.action === "get-aggregated-data" && tabId) {
    // Sort cursor points by time
    const points = (aggregatedCursorPoints[tabId] || []).sort((a, b) => a.t - b.t);
    sendResponse({
      cursorPoints: points,
      captchaElements: aggregatedCaptchaElements[tabId] || []
    });
    return true;
  }

  // Recording badge (top frame only)
  if (message.action === "recording-started" && message.isTopFrame && tabId) {
    browser.browserAction.setBadgeText({ text: "on", tabId });
    browser.browserAction.setBadgeBackgroundColor({ color: "#DC2626", tabId });
  }
  if (message.action === "recording-stopped" && message.isTopFrame && tabId) {
    browser.browserAction.setBadgeText({ text: "", tabId });
  }

  // Content script requesting captured images
  if (message.action === "get-captured-images") {
    sendResponse({ images: capturedImages[tabId] || [] });
    return true;
  }

  // Clear images for tab
  if (message.action === "clear-images") {
    capturedImages[tabId] = [];
    sendResponse({ success: true });
    return true;
  }

  // Content script asking if it should be activated (for session persistence)
  if (message.action === "get-activated-state") {
    const isActivated = activatedTabs.has(tabId);
    sendResponse({ activated: isActivated });
    return true;
  }

  // Export request - create folder and download
  if (message.action === "export-session") {
    exportSession(tabId, message.data)
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Clean up when tab closes
browser.tabs.onRemoved.addListener((tabId) => {
  activatedTabs.delete(tabId);
  delete capturedImages[tabId];
  delete aggregatedCursorPoints[tabId];
  delete aggregatedCaptchaElements[tabId];
});

// ============================================
// CAPTCHA Image Capture
// ============================================

// Detect MIME type from magic bytes (file signature)
function detectMimeFromBytes(bytes) {
  if (bytes.length < 8) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return "image/jpeg";
  }

  // GIF: 47 49 46 38 (GIF8)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }

  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    return "image/bmp";
  }

  return null; // Not a recognized image format
}

// Image URL patterns for known CAPTCHA providers (tightened - no overly broad patterns)
const CAPTCHA_IMAGE_PATTERNS = [
  // === Google reCAPTCHA ===
  "*://*.google.com/recaptcha/*/payload*",
  "*://*.google.com/recaptcha/api2/payload*",
  "*://*.google.com/recaptcha/enterprise/payload*",

  // === hCaptcha ===
  "*://*.hcaptcha.com/captcha/*",
  "*://imgs.hcaptcha.com/*",

  // === Cloudflare Turnstile ===
  "*://challenges.cloudflare.com/cdn-cgi/*",

  // === GeeTest ===
  "*://*.geetest.com/get.php*",
  "*://*.geetest.com/ajax.php*",
  "*://*.geetest.com/static/*",
  "*://api.geetest.com/*",

  // === FunCaptcha / Arkose Labs ===
  "*://*.arkoselabs.com/fc/assets/*",
  "*://*.funcaptcha.com/fc/assets/*",
  "*://client-api.arkoselabs.com/fc/assets/*",

  // === DataDome ===
  "*://dd.datadome.co/captcha/*",

  // === PerimeterX / HUMAN ===
  "*://*.perimeterx.net/captcha/*",
  "*://*.px-cdn.net/captcha/*"
];

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only capture for activated tabs
    if (details.tabId < 0 || !activatedTabs.has(details.tabId)) {
      return;
    }

    // Only capture actual image requests (not XHR which could be JSON)
    if (details.type !== "image") {
      return;
    }

    try {
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const chunks = [];

      filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data);
      };

      filter.onstop = () => {
        filter.close();

        // Combine chunks
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }

        // Validate: detect MIME type from actual bytes
        const mimeType = detectMimeFromBytes(combined);
        if (!mimeType) {
          console.log(`[CAPLOG] Skipping non-image response: ${details.url.substring(0, 80)}`);
          return; // Not an image, skip
        }

        // Skip very small images (likely icons/UI elements, not CAPTCHA challenges)
        if (combined.length < 1000) {
          console.log(`[CAPLOG] Skipping tiny image (${combined.length} bytes)`);
          return;
        }

        // Convert to base64
        let binary = "";
        for (let i = 0; i < combined.length; i++) {
          binary += String.fromCharCode(combined[i]);
        }
        const base64 = btoa(binary);

        const imageEntry = {
          timestamp: new Date().toISOString(),
          url: details.url,
          size: combined.length,
          mimeType: mimeType,
          dataUrl: `data:${mimeType};base64,${base64}`
        };

        if (!capturedImages[details.tabId]) {
          capturedImages[details.tabId] = [];
        }
        capturedImages[details.tabId].push(imageEntry);

        // Limit images per tab
        if (capturedImages[details.tabId].length > MAX_IMAGES_PER_TAB) {
          capturedImages[details.tabId] = capturedImages[details.tabId].slice(-MAX_IMAGES_PER_TAB);
        }

        // Notify content script of new image (for round counting)
        browser.tabs.sendMessage(details.tabId, {
          action: "captcha-image-captured",
          imageCount: capturedImages[details.tabId].length
        }).catch(() => {});

        console.log(`[CAPLOG] ✓ Captured ${mimeType}: ${combined.length} bytes`);
      };

      filter.onerror = () => {
        filter.close();
      };

    } catch (e) {
      // filterResponseData not available or other error
    }
  },
  { urls: CAPTCHA_IMAGE_PATTERNS },
  ["blocking"]
);

// ============================================
// Export Helpers
// ============================================

// Convert data URL to blob URL (required for downloads API)
function dataUrlToBlobUrl(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

// ============================================
// Session Export
// ============================================

async function exportSession(tabId, sessionData) {
  const images = capturedImages[tabId] || [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const folderName = `captcha-${timestamp}`;

  console.log(`[CAPLOG] Starting export: ${folderName}/`);
  console.log(`[CAPLOG]   - ${images.length} image(s)`);
  console.log(`[CAPLOG]   - ${sessionData.cursorPointCount || 0} cursor points`);
  console.log(`[CAPLOG]   - ${sessionData.frames?.length || 1} frame(s)`);
  console.log(`[CAPLOG]   - ${sessionData.rounds || 1} round(s)`);

  // Create session.json content
  const session = {
    ...sessionData,
    imageCount: images.length,
    images: images.map((img, i) => ({
      filename: `img-${String(i + 1).padStart(3, "0")}.${img.mimeType.split("/")[1]}`,
      timestamp: img.timestamp,
      url: img.url,
      size: img.size
    }))
  };

  // Download session.json
  const sessionBlob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const sessionUrl = URL.createObjectURL(sessionBlob);

  try {
    await browser.downloads.download({
      url: sessionUrl,
      filename: `${folderName}/session.json`,
      saveAs: false
    });

    // Download each image (convert data URL to blob URL first)
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ext = img.mimeType.split("/")[1];
      const filename = `img-${String(i + 1).padStart(3, "0")}.${ext}`;

      // Convert data URL to blob URL for downloads API
      const blobUrl = dataUrlToBlobUrl(img.dataUrl);

      await browser.downloads.download({
        url: blobUrl,
        filename: `${folderName}/${filename}`,
        saveAs: false
      });

      // Clean up blob URL
      URL.revokeObjectURL(blobUrl);
    }

    // Clean up session blob URL
    URL.revokeObjectURL(sessionUrl);

    console.log(`[CAPLOG] ✓ Export complete: ${folderName}/`);

    // Clear data for this tab after successful export
    capturedImages[tabId] = [];
    aggregatedCursorPoints[tabId] = [];
    aggregatedCaptchaElements[tabId] = [];

    return true;
  } catch (err) {
    console.error(`[CAPLOG] Export failed:`, err);
    throw err;
  }
}

console.log("[CAPLOG] Background script loaded (frame-aware aggregation active).");