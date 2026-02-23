// main.js - Content script for CAPTCHA Diary (Frame-Aware Continuous Mode)
// Top frame: manages state, shows indicator, triggers save, injects favicon
// Child frames: silently capture cursor data, send to background

// ============================================
// Frame Detection
// ============================================

const isTopFrame = (window === window.top);
const frameId = Math.random().toString(36).slice(2, 10);
const frameUrl = window.location.href;
const frameDepth = (() => {
  let depth = 0, win = window;
  while (win !== win.top) { depth++; win = win.parent; }
  return depth;
})();

// ============================================
// State
// ============================================

let isMonitoring = false;
let isRecording = false;
let recordingStartTime = 0;
let cursorPoints = [];
let captchaElements = [];
let roundCount = 0;
let lastImageCount = 0;
let lastCursorTime = 0;
let intervalExportTimer = null;
let lastInlineExtractionTime = 0;

const EXPORT_CONFIG = {
  onNavigation: true,
  intervalEnabled: true,
  intervalMs: 60000
};

// ============================================
// Favicon Injection (top frame only)
// ============================================

let originalFaviconHref = null;
let injectedFaviconLink = null;
let faviconObserver = null;

function saveFavicon() {
  if (!isTopFrame) return;
  const el = document.querySelector('link[rel~="icon"]');
  originalFaviconHref = el ? el.href : null;
}

// Keep our dot as the last <link rel="icon"> in <head>.
// Called by faviconObserver whenever the page adds/removes children of <head>.
function _assertFaviconPosition() {
  if (!injectedFaviconLink || !document.head) return;
  const links = document.head.querySelectorAll('link[rel~="icon"]');
  if (!links.length || links[links.length - 1] !== injectedFaviconLink) {
    document.head.appendChild(injectedFaviconLink);
  }
}

function setFaviconDot(state) { // state: "gray" | "red" | "restore"
  if (!isTopFrame) return;

  // Remove any existing dot link first. Null it before removal so the
  // faviconObserver callback sees null and returns early (no re-assertion loop).
  const old = injectedFaviconLink;
  injectedFaviconLink = null;
  if (old) old.remove();

  if (state === "restore") {
    if (faviconObserver) { faviconObserver.disconnect(); faviconObserver = null; }
    // Let the browser fall back to whatever <link rel="icon"> the page had originally.
    return;
  }

  // Create a fresh <link> element for the new state so the browser
  // always processes a real insertion (pure href mutation can be ignored by some renderers).
  injectedFaviconLink = document.createElement("link");
  injectedFaviconLink.rel = "icon";
  injectedFaviconLink.id = "captcha-diary-favicon";
  try {
    injectedFaviconLink.href = browser.runtime.getURL(`icons/dot-${state}.png`);
  } catch (e) {}
  document.head.appendChild(injectedFaviconLink);

  // Watch <head> for new favicon links added by the page; re-assert our position.
  if (!faviconObserver && document.head) {
    faviconObserver = new MutationObserver(_assertFaviconPosition);
    faviconObserver.observe(document.head, { childList: true });
  }
}

// ============================================
// Cursor Tracking
// ============================================

function handleMouseMove(event) {
  if (!isRecording) return;

  const now = Date.now();
  const overCaptcha = isOverCaptcha(event.clientX, event.clientY);

  const point = {
    x: event.clientX,
    y: event.clientY,
    t: now - recordingStartTime,
    overCaptcha,
    frameId,
    frameUrl,
    frameDepth
  };

  cursorPoints.push(point);

  browser.runtime.sendMessage({ action: "cursor-point", point }).catch(() => {});

  if (isTopFrame && overCaptcha) {
    lastCursorTime = now;
    if (hasUserInteraction && captchaElements.length > 0) {
      if (!lastInlineExtractionTime || (now - lastInlineExtractionTime > 2000)) {
        lastInlineExtractionTime = now;
        extractAllInlineCaptchaImages();
      }
    }
  }
}

function isOverCaptcha(x, y) {
  for (const captcha of captchaElements) {
    const r = captcha.rect;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}

// ============================================
// Interval-Based Save (backup timer)
// ============================================

function startIntervalExportTimer() {
  if (!isTopFrame || !EXPORT_CONFIG.intervalEnabled) return;
  stopIntervalExportTimer();
  intervalExportTimer = setInterval(() => {
    if (isRecording && cursorPoints.length > 0) {
      console.log("[DIARY] Interval save triggered...");
      saveSession("interval");
    }
  }, EXPORT_CONFIG.intervalMs);
}

function stopIntervalExportTimer() {
  if (intervalExportTimer) { clearInterval(intervalExportTimer); intervalExportTimer = null; }
}

// ============================================
// Navigation-Based Save (beforeunload)
// ============================================

function setupNavigationExport() {
  if (!isTopFrame || !EXPORT_CONFIG.onNavigation) return;

  window.addEventListener("beforeunload", () => {
    if (isRecording && cursorPoints.length > 0) {
      // Best-effort fire-and-forget during unload
      browser.runtime.sendMessage({
        action: "save-session",
        data: buildSessionData("navigation")
      }).catch(() => {});
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isRecording && cursorPoints.length > 0) {
      saveSession("visibility-hidden");
    }
  });
}

// ============================================
// CAPTCHA Detection
// ============================================

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]', '.g-recaptcha', '[class*="recaptcha"]', '[id*="recaptcha"]',
  'iframe[src*="hcaptcha"]', '.h-captcha', '[class*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare"]', 'iframe[src*="turnstile"]', '.cf-turnstile', '[class*="turnstile"]',
  '.geetest_panel', '.geetest_widget', '[class*="geetest"]', 'iframe[src*="geetest"]',
  '#FunCaptcha', '[class*="funcaptcha"]', '[class*="arkose"]', 'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
  '[class*="slider-wrapper"]', '[class*="slider_wrapper"]', '[class*="slide-verify"]', '[class*="slideverify"]',
  '[class*="slider-captcha"]', '[class*="slide_captcha"]', '[class*="drag-verify"]', '[class*="puzzle-captcha"]',
  '[class*="captcha"]', '[id*="captcha"]', '[class*="verification"]', '[id*="verification"]',
  '#verification', '[class*="verify-wrap"]', '[class*="verify_wrap"]',
  '[class*="slider-verify"]', '[class*="slider_verify"]', '[class*="captcha-slider"]', '[class*="captcha_slider"]',
  'iframe[src*="datadome"]', '[class*="datadome"]',
  'iframe[src*="perimeterx"]', 'iframe[src*="px-captcha"]', '[class*="px-captcha"]',
  '[class*="keycaptcha"]', '#keycaptcha',
  '[class*="security-check"]', '[class*="security_check"]', '[class*="bot-check"]', '[class*="human-verify"]'
];

function getCssSelector(element) {
  if (!element || element === document.body) return "body";
  if (element.id) return `#${element.id}`;
  const parts = [];
  let el = element;
  while (el && el !== document.body && parts.length < 5) {
    let selector = el.tagName.toLowerCase();
    if (el.id) { selector = `#${el.id}`; parts.unshift(selector); break; }
    if (el.className && typeof el.className === "string") {
      const classes = el.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length > 0 && classes[0]) selector += "." + classes.join(".");
    }
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      if (siblings.length > 1) selector += `:nth-child(${siblings.indexOf(el) + 1})`;
    }
    parts.unshift(selector);
    el = el.parentElement;
  }
  return parts.join(" > ");
}

function extractPromptText(element) {
  const promptSelectors = [
    '.rc-imageselect-desc-wrapper', '.rc-imageselect-desc', '.rc-imageselect-instructions',
    '.prompt-text', '[class*="prompt"]', '[class*="instruction"]'
  ];
  for (const sel of promptSelectors) {
    const prompt = element.querySelector(sel);
    if (prompt && prompt.textContent) return prompt.textContent.trim();
  }
  const parent = element.parentElement;
  if (parent) {
    for (const sel of promptSelectors) {
      const prompt = parent.querySelector(sel);
      if (prompt && prompt.textContent) return prompt.textContent.trim();
    }
  }
  return null;
}

const CAPTCHA_TEXT_PATTERNS = [
  /verify\s*you.*human/i, /are\s*you.*robot/i,
  /prove\s*you.*human/i, /slide\s*to\s*verify/i, /drag.*puzzle/i,
  /human\s*verification/i, /bot\s*protection/i,
  // Restored: specific enough that the container-size guard prevents false positives on general pages
  /security\s*verification/i, /security\s*check/i,
  /complete.*verification/i, /verification.*required/i
  // Still excluded: /captcha/i — matches pages ABOUT captchas, not actual widgets
];

const BLACKLIST_TEXT_PATTERNS = [
  /how to/i, /about/i, /tutorial/i, /article/i, /guide/i, /definition/i, /example/i
];

function findCaptchaByText() {
  const found = [];
  const candidates = document.querySelectorAll("div, span, h1, h2, h3, h4, p");
  for (const el of candidates) {
    const text = el.textContent?.trim() || "";
    // if (BLACKLIST_TEXT_PATTERNS.some(p => p.test(text))) continue;
    if (text.length > 100) continue;
    for (const pattern of CAPTCHA_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        let container = el.parentElement;
        let depth = 0;
        while (container && depth < 5) {
          const rect = container.getBoundingClientRect();
          if (rect.width > 100 && rect.height > 100 &&
              rect.width < window.innerWidth * 0.9 && rect.height < window.innerHeight * 0.9) {
            found.push(container);
            break;
          }
          container = container.parentElement;
          depth++;
        }
        break;
      }
    }
  }
  return found;
}

function detectCaptchaElements() {
  captchaElements = [];
  const seenElements = new Set();

  for (const selector of CAPTCHA_SELECTORS) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (seenElements.has(el)) continue;
        // Never match our own injected UI elements (indicator div, favicon link)
        if (el.id && el.id.startsWith("captcha-diary-")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          seenElements.add(el);
          captchaElements.push({
            element: el,
            selector: getCssSelector(el),
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
            promptText: extractPromptText(el),
            tagName: el.tagName.toLowerCase(),
            src: el.src || null,
            frameId, frameUrl, frameDepth,
            detectionMethod: "selector"
          });
        }
      }
    } catch (e) {}
  }

  try {
    for (const el of findCaptchaByText()) {
      if (seenElements.has(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        seenElements.add(el);
        captchaElements.push({
          element: el,
          selector: getCssSelector(el),
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          promptText: extractPromptText(el),
          tagName: el.tagName.toLowerCase(),
          src: el.src || null,
          frameId, frameUrl, frameDepth,
          detectionMethod: "text-content"
        });
      }
    }
  } catch (e) {}

  if (captchaElements.length > 0) {
    browser.runtime.sendMessage({
      action: "captcha-elements",
      elements: captchaElements.map(c => ({
        selector: c.selector, rect: c.rect, promptText: c.promptText,
        tagName: c.tagName, src: c.src, frameId: c.frameId, frameUrl: c.frameUrl, frameDepth: c.frameDepth
      }))
    }).catch(() => {});
    extractAllInlineCaptchaImages();
  }

  return captchaElements.length > 0;
}

// ============================================
// DOM-Based Image Extraction
// ============================================

function extractInlineCaptchaImages(captchaElement) {
  const extractedImages = [];
  const MIN_IMAGE_SIZE = 50;
  const MIN_DATA_LENGTH = 500;

  const inlineImages = captchaElement.querySelectorAll('img[src^="data:image"]');
  for (const img of inlineImages) {
    try {
      const rect = img.getBoundingClientRect();
      if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE && img.src.length >= MIN_DATA_LENGTH) {
        extractedImages.push({
          type: "inline-image", dataUrl: img.src,
          width: rect.width, height: rect.height,
          selector: getCssSelector(img), timestamp: new Date().toISOString()
        });
      }
    } catch (e) {}
  }

  const canvasElements = captchaElement.querySelectorAll("canvas");
  for (const canvas of canvasElements) {
    try {
      const rect = canvas.getBoundingClientRect();
      if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE) {
        try {
          const dataUrl = canvas.toDataURL("image/png");
          if (dataUrl.length >= MIN_DATA_LENGTH) {
            extractedImages.push({
              type: "canvas", dataUrl,
              width: canvas.width, height: canvas.height,
              displayWidth: rect.width, displayHeight: rect.height,
              selector: getCssSelector(canvas), timestamp: new Date().toISOString()
            });
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  const elementsWithBg = captchaElement.querySelectorAll("*");
  for (const el of elementsWithBg) {
    try {
      const style = window.getComputedStyle(el);
      const bgImage = style.backgroundImage;
      if (bgImage && bgImage.startsWith('url("data:image')) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE) {
          const match = bgImage.match(/url\("(data:image[^"]+)"\)/);
          if (match && match[1] && match[1].length >= MIN_DATA_LENGTH) {
            extractedImages.push({
              type: "background-image", dataUrl: match[1],
              width: rect.width, height: rect.height,
              selector: getCssSelector(el), timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (e) {}
  }

  return extractedImages;
}

function extractAllInlineCaptchaImages() {
  const allImages = [];
  const seenDataUrls = new Set();
  for (const captcha of captchaElements) {
    for (const img of extractInlineCaptchaImages(captcha.element)) {
      const urlKey = img.dataUrl.substring(0, 200);
      if (!seenDataUrls.has(urlKey)) {
        seenDataUrls.add(urlKey);
        allImages.push({ ...img, captchaSelector: captcha.selector, frameId, frameUrl, frameDepth });
      }
    }
  }
  if (allImages.length > 0) {
    browser.runtime.sendMessage({ action: "captcha-inline-images", images: allImages }).catch(() => {});
  }
  return allImages;
}

let hasUserInteraction = false;

function setupUserInteractionTracking() {
  const markInteraction = () => {
    if (!hasUserInteraction) {
      hasUserInteraction = true;
      if (isRecording && captchaElements.length > 0) extractAllInlineCaptchaImages();
    }
  };
  document.addEventListener("click", markInteraction, { passive: true });
  document.addEventListener("mousedown", markInteraction, { passive: true });
  document.addEventListener("keydown", markInteraction, { passive: true });
}

setupUserInteractionTracking();

// ============================================
// MutationObserver
// ============================================

let captchaObserver = null;

function startCaptchaObserver() {
  if (captchaObserver) return;
  captchaObserver = new MutationObserver(() => {
    const hadCaptcha = captchaElements.length > 0;
    const hasCaptcha = detectCaptchaElements();

    if (!hadCaptcha && hasCaptcha && isMonitoring && !isRecording) {
      if (isTopFrame) console.log("[DIARY] CAPTCHA detected — starting recording...");
      startRecording();
    }

    if (hadCaptcha && !hasCaptcha && isRecording && isTopFrame) {
      console.log("[DIARY] CAPTCHA removed from DOM — saving session...");
      browser.runtime.sendMessage({ action: "captcha-disappeared", isTopFrame: true }).catch(() => {});
      saveSession("captcha-disappeared").then(() => resetRecording());
    }
  });

  captchaObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "class", "style"]
  });
}

function stopCaptchaObserver() {
  if (captchaObserver) { captchaObserver.disconnect(); captchaObserver = null; }
}

// ============================================
// Recording Control
// ============================================

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  recordingStartTime = Date.now();
  cursorPoints = [];
  roundCount = 1;
  lastImageCount = 0;
  lastCursorTime = Date.now();

  detectCaptchaElements();
  document.addEventListener("mousemove", handleMouseMove);

  // Notify background (badge)
  browser.runtime.sendMessage({
    action: "captcha-appeared",
    isTopFrame,
    elementCount: captchaElements.length
  }).catch(() => {});

  if (isTopFrame) {
    setFaviconDot("red");
    showRecordingIndicator();
    startIntervalExportTimer();
    console.log(`[DIARY] Recording started — ${captchaElements.length} element(s)`);
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  document.removeEventListener("mousemove", handleMouseMove);

  if (isTopFrame) {
    stopIntervalExportTimer();
    hideRecordingIndicator();
    setFaviconDot("gray");
    console.log(`[DIARY] Recording stopped — ${cursorPoints.length} cursor pts, ${roundCount} round(s)`);
  }
}

function resetRecording() {
  cursorPoints = [];
  captchaElements = [];
  roundCount = 0;
  lastImageCount = 0;
  lastCursorTime = 0;
  isRecording = false;
  browser.runtime.sendMessage({ action: "clear-cursor-data" }).catch(() => {});
  if (isTopFrame) console.log("[DIARY] Reset — waiting for next CAPTCHA...");
}

// ============================================
// Monitoring Activation
// ============================================

function startMonitoring() {
  if (isMonitoring) return;
  isMonitoring = true;

  if (isTopFrame) {
    console.log("[DIARY] Monitoring active (top frame)");
  } else {
    console.log(`[DIARY] Monitoring active (child frame depth=${frameDepth})`);
  }

  // document.body may be null at document_start; defer DOM work until it exists.
  if (document.body) {
    _beginObservingDOM();
  } else {
    document.addEventListener("DOMContentLoaded", _beginObservingDOM, { once: true });
  }
}

function _beginObservingDOM() {
  // Favicon: set up now that <head> and <body> exist.
  if (isTopFrame) {
    saveFavicon();
    setFaviconDot("gray");
  }

  startCaptchaObserver();
  detectCaptchaElements();

  if (captchaElements.length > 0) {
    if (isTopFrame) console.log("[DIARY] CAPTCHA already present — starting recording...");
    startRecording();
  }
}

// ============================================
// Session Save
// ============================================

function buildSessionData(trigger) {
  const allCursorPoints = cursorPoints; // local frame points; background has aggregated
  const duration = allCursorPoints.length > 0 ? allCursorPoints[allCursorPoints.length - 1].t : 0;

  const frameStats = {};
  allCursorPoints.forEach(p => {
    if (!frameStats[p.frameId]) frameStats[p.frameId] = { count: 0, url: p.frameUrl, depth: p.frameDepth };
    frameStats[p.frameId].count++;
  });

  return {
    recordedAt: new Date(recordingStartTime).toISOString(),
    sourceUrl: window.location.href,
    hostname: window.location.hostname,
    duration,
    rounds: roundCount,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    frames: Object.entries(frameStats).map(([fid, stats]) => ({
      frameId: fid, url: stats.url, depth: stats.depth, cursorPointCount: stats.count
    })),
    captchaElements: captchaElements.map(c => ({
      selector: c.selector, rect: c.rect, promptText: c.promptText,
      tagName: c.tagName, src: c.src, frameId: c.frameId, frameUrl: c.frameUrl, frameDepth: c.frameDepth
    })),
    cursorPoints: allCursorPoints,
    cursorPointCount: allCursorPoints.length,
    exportTrigger: trigger
  };
}

async function saveSession(trigger) {
  if (!isTopFrame) return false;

  stopRecording();

  // Require at least some captured images
  let capturedImageCount = 0;
  try {
    const imgResponse = await browser.runtime.sendMessage({ action: "get-captured-images" });
    capturedImageCount = (imgResponse.images || []).length;
  } catch (e) {}

  if (capturedImageCount === 0) {
    console.log("[DIARY] Skipping save — no images captured");
    return false;
  }

  // Get aggregated data from background (all frames)
  let aggregatedData = { cursorPoints: cursorPoints, captchaElements: [] };
  try {
    aggregatedData = await browser.runtime.sendMessage({ action: "get-aggregated-data" });
  } catch (e) {}

  const sessionData = {
    ...buildSessionData(trigger),
    cursorPoints: aggregatedData.cursorPoints || cursorPoints,
    cursorPointCount: (aggregatedData.cursorPoints || cursorPoints).length,
    captchaElements: aggregatedData.captchaElements || captchaElements.map(c => ({
      selector: c.selector, rect: c.rect, promptText: c.promptText,
      tagName: c.tagName, src: c.src, frameId: c.frameId, frameUrl: c.frameUrl, frameDepth: c.frameDepth
    }))
  };

  try {
    const response = await browser.runtime.sendMessage({ action: "save-session", data: sessionData });
    if (response.success) {
      console.log("[DIARY] Session saved successfully");
      return true;
    } else {
      console.error("[DIARY] Save failed:", response.error);
      return false;
    }
  } catch (e) {
    console.error("[DIARY] Save error:", e);
    return false;
  }
}

// ============================================
// Visual Indicator (top frame only)
// ============================================

let indicatorEl = null;

function showRecordingIndicator() {
  if (!isTopFrame || indicatorEl) return;
  indicatorEl = document.createElement("div");
  indicatorEl.id = "captcha-diary-indicator";
  indicatorEl.innerHTML = `
    <style>
      #captcha-diary-indicator {
        position: fixed; top: 10px; right: 10px; z-index: 999999;
        background: rgba(220, 38, 38, 0.95); color: white;
        padding: 8px 14px; border-radius: 6px;
        font-family: system-ui, sans-serif; font-size: 12px;
        display: flex; align-items: center; gap: 10px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        pointer-events: auto;
      }
      #captcha-diary-indicator .dot {
        width: 8px; height: 8px; background: white; border-radius: 50%;
        animation: diary-blink 1s infinite;
      }
      @keyframes diary-blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
      #captcha-diary-indicator .info { font-size: 10px; opacity: 0.8; }
      #captcha-diary-end-btn {
        cursor: pointer; background: rgba(255,255,255,0.2); border: none;
        color: white; padding: 2px 8px; border-radius: 4px;
        font-size: 11px; font-family: inherit; margin-left: 4px;
      }
      #captcha-diary-end-btn:hover { background: rgba(255,255,255,0.35); }
    </style>
    <span class="dot"></span>
    <span>Recording CAPTCHA</span>
    <span class="info">(auto-saves)</span>
    <button id="captcha-diary-end-btn">End</button>
  `;
  document.body.appendChild(indicatorEl);
  const endBtn = document.getElementById("captcha-diary-end-btn");
  if (endBtn) {
    endBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      saveSession("manual").then(() => resetRecording());
    });
  }
}

function hideRecordingIndicator() {
  if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
}

// ============================================
// Keyboard Shortcut (top frame only)
// ============================================

document.addEventListener("keydown", (event) => {
  if (!isTopFrame) return;
  if (event.ctrlKey && event.shiftKey && event.code === "KeyE") {
    event.preventDefault();
    if (isRecording) {
      console.log("[DIARY] Manual save triggered");
      saveSession("manual").then(() => resetRecording());
    }
  }
});

// ============================================
// Message Handling
// ============================================

browser.runtime.onMessage.addListener((message) => {
  // Background tells this tab it's being watched → start monitoring
  if (message.action === "you-are-watched") {
    startMonitoring();
  }

  // Consent was granted for this window → start monitoring
  if (message.action === "consent-granted") {
    startMonitoring();
  }

  // New image captured → round counting (top frame only)
  if (message.action === "captcha-image-captured" && isTopFrame) {
    if (message.imageCount > lastImageCount) {
      const newImages = message.imageCount - lastImageCount;
      console.log(`[DIARY] ${newImages} new image(s) captured (total: ${message.imageCount})`);
      if (isRecording && newImages >= 3) {
        roundCount++;
        console.log(`[DIARY] Round ${roundCount} detected`);
      }
      lastImageCount = message.imageCount;
    }
  }
});

// ============================================
// Console API
// ============================================

window.captchaDiary = {
  save: saveSession,
  getData: () => ({
    isMonitoring,
    isRecording,
    isTopFrame,
    frameId,
    frameDepth,
    cursorPoints: cursorPoints.length,
    captchaElements: captchaElements.map(c => c.selector),
    duration: isRecording ? Date.now() - recordingStartTime : 0,
    rounds: roundCount
  }),
  getFrameInfo: () => ({ frameId, frameUrl, frameDepth, isTopFrame })
};

// ============================================
// Startup
// ============================================

if (isTopFrame) {
  console.log("[DIARY] Content script loaded (TOP FRAME)");
  console.log(`[DIARY] Export config: navigation=${EXPORT_CONFIG.onNavigation}, interval=${EXPORT_CONFIG.intervalEnabled ? EXPORT_CONFIG.intervalMs/1000 + "s" : "off"}`);
  setupNavigationExport();
} else {
  console.log(`[DIARY] Content script loaded (child frame, depth=${frameDepth})`);
}

// Check consent and watched state on load
(async function initialize() {
  try {
    // Check if already watched (e.g., navigated within a watched tab)
    const watchedResp = await browser.runtime.sendMessage({ action: "check-watched" });
    if (watchedResp && watchedResp.watched) {
      startMonitoring();
      return;
    }
    // Check if this window has been consented (will activate on next tab visit)
    const consentResp = await browser.runtime.sendMessage({ action: "check-consent" });
    if (consentResp && consentResp.consented) {
      // Window is consented but background hasn't sent "you-are-watched" yet
      // (can happen on page reload within an already-watched tab)
      startMonitoring();
    }
    // else: wait for "you-are-watched" or "consent-granted" message
  } catch (e) {
    // Extension context not available (e.g., privileged pages)
  }
})();
