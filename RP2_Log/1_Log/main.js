// main.js - Content script for CAPTCHA logging (Frame-Aware Continuous Mode)
// Top frame: manages state, shows indicator, triggers export
// Child frames: silently capture cursor data, send to background

// ============================================
// Frame Detection
// ============================================

const isTopFrame = (window === window.top);
const frameId = Math.random().toString(36).slice(2, 10); // Unique ID for this frame instance
const frameUrl = window.location.href;
const frameDepth = (() => {
  let depth = 0;
  let win = window;
  while (win !== win.top) {
    depth++;
    win = win.parent;
  }
  return depth;
})();

// ============================================
// State
// ============================================

let isArmed = false;
let isRecording = false;
let recordingStartTime = 0;
let cursorPoints = [];
let captchaElements = [];  // {element, selector, rect, promptText}
let roundCount = 0;
let lastImageCount = 0;
let lastCursorTime = 0;
let inactivityTimer = null;
let intervalExportTimer = null;
let lastInlineExtractionTime = 0; // Debounce for inline image extraction

// Export timing configuration
const EXPORT_CONFIG = {
  // Primary: export on page navigation (beforeunload)
  onNavigation: true,

  // Backup: periodic interval export (in case user stays on page long time)
  intervalEnabled: true,
  intervalMs: 60000, // Export every 60 seconds while recording

  // Legacy: inactivity-based auto-export (set false to prevent fragmentation)
  onInactivity: false,
  inactivityTimeoutMs: 8000
};

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
    overCaptcha: overCaptcha,
    // Frame context
    frameId: frameId,
    frameUrl: frameUrl,
    frameDepth: frameDepth
  };

  cursorPoints.push(point);

  // Send cursor data to background for aggregation (all frames do this)
  browser.runtime.sendMessage({
    action: "cursor-point",
    point: point
  }).catch(() => {});

  // Track activity for auto-export (top frame only manages this)
  if (isTopFrame && overCaptcha) {
    lastCursorTime = now;
    resetInactivityTimer();

    // Re-extract inline images when user interacts with CAPTCHA
    // (Firefox requires user interaction for canvas.toDataURL)
    if (hasUserInteraction && captchaElements.length > 0) {
      // Debounce: only extract every 2 seconds max
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
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return true;
    }
  }
  return false;
}

// ============================================
// Inactivity Detection (top frame only)
// ============================================

function resetInactivityTimer() {
  if (!isTopFrame) return; // Only top frame manages timers

  // Skip inactivity-based export if disabled
  if (!EXPORT_CONFIG.onInactivity) return;

  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
  }

  inactivityTimer = setTimeout(() => {
    if (isRecording && cursorPoints.length > 0) {
      // Check if CAPTCHA is still visible
      const stillHasCaptcha = detectCaptchaElements();
      if (!stillHasCaptcha) {
        console.log("[CAPLOG] CAPTCHA disappeared - auto-exporting...");
        autoExportAndReset();
      } else if (Date.now() - lastCursorTime > EXPORT_CONFIG.inactivityTimeoutMs) {
        console.log("[CAPLOG] Cursor inactive over CAPTCHA - auto-exporting...");
        autoExportAndReset();
      }
    }
  }, EXPORT_CONFIG.inactivityTimeoutMs);
}

async function autoExportAndReset() {
  if (!isTopFrame) return; // Only top frame exports
  await exportSession();
  resetRecording();
}

// ============================================
// Interval-Based Export (backup timer)
// ============================================

function startIntervalExportTimer() {
  if (!isTopFrame || !EXPORT_CONFIG.intervalEnabled) return;

  stopIntervalExportTimer(); // Clear any existing timer

  intervalExportTimer = setInterval(() => {
    if (isRecording && cursorPoints.length > 0) {
      console.log("[CAPLOG] Interval export triggered (backup timer)...");
      // Export but DON'T reset - keep accumulating data
      exportSession().then(() => {
        console.log("[CAPLOG] Interval export complete - continuing recording");
      });
    }
  }, EXPORT_CONFIG.intervalMs);

  console.log(`[CAPLOG] Interval export timer started (${EXPORT_CONFIG.intervalMs / 1000}s)`);
}

function stopIntervalExportTimer() {
  if (intervalExportTimer) {
    clearInterval(intervalExportTimer);
    intervalExportTimer = null;
  }
}

// ============================================
// Navigation-Based Export (beforeunload)
// ============================================

function setupNavigationExport() {
  if (!isTopFrame || !EXPORT_CONFIG.onNavigation) return;

  // Export when user navigates away or closes tab
  window.addEventListener("beforeunload", (event) => {
    if (isRecording && cursorPoints.length > 0) {
      console.log("[CAPLOG] Page navigation detected - exporting...");
      // Use sendBeacon for reliable delivery during page unload
      exportSessionSync();
    }
  });

  // Also handle visibility change (tab switch, minimize)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isRecording && cursorPoints.length > 0) {
      console.log("[CAPLOG] Page hidden - exporting as precaution...");
      exportSession(); // Async is fine here, page isn't unloading
    }
  });

  console.log("[CAPLOG] Navigation export handler registered");
}

// Synchronous export for beforeunload (limited but best-effort)
function exportSessionSync() {
  if (!isTopFrame) return;

  // Can't do full async export during beforeunload, but we can send message
  // The background script will receive this even if the page unloads
  try {
    browser.runtime.sendMessage({
      action: "export-session",
      data: {
        version: "0.2",
        recordedAt: new Date().toISOString(),
        sourceUrl: window.location.href,
        hostname: window.location.hostname,
        duration: cursorPoints.length > 0 ? cursorPoints[cursorPoints.length - 1].t : 0,
        rounds: roundCount,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        frames: [{ frameId, url: frameUrl, depth: frameDepth, cursorPointCount: cursorPoints.length }],
        captchaElements: captchaElements.map(c => ({
          selector: c.selector, rect: c.rect, promptText: c.promptText,
          tagName: c.tagName, src: c.src, frameId: c.frameId
        })),
        cursorPoints: cursorPoints,
        cursorPointCount: cursorPoints.length,
        exportTrigger: "navigation"
      }
    });
  } catch (e) {
    console.warn("[CAPLOG] Sync export failed:", e);
  }
}

function resetRecording() {
  cursorPoints = [];
  captchaElements = [];
  roundCount = 0;
  lastImageCount = 0;
  lastCursorTime = 0;
  isRecording = false;

  // Tell background to clear aggregated cursor data for this tab
  browser.runtime.sendMessage({ action: "clear-cursor-data" }).catch(() => {});

  // Stay armed, wait for next CAPTCHA
  if (isTopFrame) {
    console.log("[CAPLOG] Reset complete. Waiting for next CAPTCHA...");
  }
}

// ============================================
// CAPTCHA Detection
// ============================================

// Comprehensive CAPTCHA selectors for multiple providers
const CAPTCHA_SELECTORS = [
  // === Google reCAPTCHA ===
  'iframe[src*="recaptcha"]',
  '.g-recaptcha',
  '[class*="recaptcha"]',
  '[id*="recaptcha"]',

  // === hCaptcha ===
  'iframe[src*="hcaptcha"]',
  '.h-captcha',
  '[class*="hcaptcha"]',

  // === Cloudflare Turnstile ===
  'iframe[src*="challenges.cloudflare"]',
  'iframe[src*="turnstile"]',
  '.cf-turnstile',
  '[class*="turnstile"]',

  // === GeeTest ===
  '.geetest_panel',
  '.geetest_widget',
  '[class*="geetest"]',
  'iframe[src*="geetest"]',

  // === FunCaptcha / Arkose Labs ===
  '#FunCaptcha',
  '[class*="funcaptcha"]',
  '[class*="arkose"]',
  'iframe[src*="arkoselabs"]',
  'iframe[src*="funcaptcha"]',

  // === Slider CAPTCHAs (common pattern) ===
  '[class*="slider-wrapper"]',
  '[class*="slider_wrapper"]',
  '[class*="slide-verify"]',
  '[class*="slideverify"]',
  '[class*="slider-captcha"]',
  '[class*="slide_captcha"]',
  '[class*="drag-verify"]',
  '[class*="puzzle-captcha"]',

  // === Generic verification patterns ===
  '[class*="captcha"]',
  '[id*="captcha"]',
  '[class*="verification"]',
  '[id*="verification"]',
  '#verification',  // Temu specific
  '[class*="verify-wrap"]',
  '[class*="verify_wrap"]',

  // === Temu / Pinduoduo ===
  '[class*="slider-verify"]',
  '[class*="slider_verify"]',
  '[class*="captcha-slider"]',
  '[class*="captcha_slider"]',

  // === DataDome ===
  'iframe[src*="datadome"]',
  '[class*="datadome"]',

  // === PerimeterX / HUMAN ===
  'iframe[src*="perimeterx"]',
  'iframe[src*="px-captcha"]',
  '[class*="px-captcha"]',

  // === KeyCaptcha ===
  '[class*="keycaptcha"]',
  '#keycaptcha',

  // === Text-based detection (title elements) ===
  '[class*="security-check"]',
  '[class*="security_check"]',
  '[class*="bot-check"]',
  '[class*="human-verify"]'
];

function getCssSelector(element) {
  if (!element || element === document.body) return "body";

  if (element.id) {
    return `#${element.id}`;
  }

  const parts = [];
  let el = element;

  while (el && el !== document.body && parts.length < 5) {
    let selector = el.tagName.toLowerCase();

    if (el.id) {
      selector = `#${el.id}`;
      parts.unshift(selector);
      break;
    }

    if (el.className && typeof el.className === "string") {
      const classes = el.className.trim().split(/\s+/).slice(0, 2);
      if (classes.length > 0 && classes[0]) {
        selector += "." + classes.join(".");
      }
    }

    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(el) + 1;
        selector += `:nth-child(${index})`;
      }
    }

    parts.unshift(selector);
    el = el.parentElement;
  }

  return parts.join(" > ");
}

function extractPromptText(element) {
  const promptSelectors = [
    '.rc-imageselect-desc-wrapper',
    '.rc-imageselect-desc',
    '.rc-imageselect-instructions',
    '.prompt-text',
    '[class*="prompt"]',
    '[class*="instruction"]'
  ];

  for (const sel of promptSelectors) {
    const prompt = element.querySelector(sel);
    if (prompt && prompt.textContent) {
      return prompt.textContent.trim();
    }
  }

  const parent = element.parentElement;
  if (parent) {
    for (const sel of promptSelectors) {
      const prompt = parent.querySelector(sel);
      if (prompt && prompt.textContent) {
        return prompt.textContent.trim();
      }
    }
  }

  return null;
}

// Text patterns that indicate CAPTCHA/verification UI
const CAPTCHA_TEXT_PATTERNS = [
  /security\s*verification/i,
  /verify\s*you.*human/i,
  /are\s*you.*robot/i,
  /prove\s*you.*human/i,
  /slide\s*to\s*verify/i,
  /drag.*puzzle/i,
  /complete.*verification/i,
  /verification.*required/i,
  /human\s*verification/i,
  /bot\s*protection/i,
  /captcha/i
];

// Find elements by text content (for randomized class names like Temu)
function findCaptchaByText() {
  const found = [];

  // Check for title/header elements with CAPTCHA-related text
  const candidates = document.querySelectorAll('div, span, h1, h2, h3, h4, p');

  for (const el of candidates) {
    // Only check direct text content to avoid deep nesting false positives
    const text = el.textContent?.trim() || '';
    if (text.length > 100) continue; // Skip large text blocks

    for (const pattern of CAPTCHA_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        // Found a CAPTCHA indicator - look for the container
        let container = el.parentElement;
        let depth = 0;
        while (container && depth < 5) {
          const rect = container.getBoundingClientRect();
          // Look for a reasonably sized container (not too small, not full page)
          if (rect.width > 100 && rect.height > 100 &&
              rect.width < window.innerWidth * 0.9 &&
              rect.height < window.innerHeight * 0.9) {
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
  const seenElements = new Set(); // Avoid duplicates

  // Method 1: CSS selector-based detection
  for (const selector of CAPTCHA_SELECTORS) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (seenElements.has(el)) continue;

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          seenElements.add(el);
          captchaElements.push({
            element: el,
            selector: getCssSelector(el),
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            },
            promptText: extractPromptText(el),
            tagName: el.tagName.toLowerCase(),
            src: el.src || null,
            frameId: frameId,
            frameUrl: frameUrl,
            frameDepth: frameDepth,
            detectionMethod: 'selector'
          });
        }
      }
    } catch (e) {}
  }

  // Method 2: Text content-based detection (for randomized class names)
  try {
    const textMatches = findCaptchaByText();
    for (const el of textMatches) {
      if (seenElements.has(el)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        seenElements.add(el);
        captchaElements.push({
          element: el,
          selector: getCssSelector(el),
          rect: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
          },
          promptText: extractPromptText(el),
          tagName: el.tagName.toLowerCase(),
          src: el.src || null,
          frameId: frameId,
          frameUrl: frameUrl,
          frameDepth: frameDepth,
          detectionMethod: 'text-content'
        });
      }
    }
  } catch (e) {}

  // Report CAPTCHA elements to background (for aggregation)
  if (captchaElements.length > 0) {
    browser.runtime.sendMessage({
      action: "captcha-elements",
      elements: captchaElements.map(c => ({
        selector: c.selector,
        rect: c.rect,
        promptText: c.promptText,
        tagName: c.tagName,
        src: c.src,
        frameId: c.frameId,
        frameUrl: c.frameUrl,
        frameDepth: c.frameDepth
      }))
    }).catch(() => {});

    // Extract inline images from detected CAPTCHA elements
    // (for Temu-style inline base64 and canvas-rendered CAPTCHAs)
    extractAllInlineCaptchaImages();
  }

  return captchaElements.length > 0;
}

// ============================================
// DOM-Based Image Extraction
// ============================================

// Extract inline images (data URLs) and canvas elements from CAPTCHA containers
// This captures images that don't come through network requests (e.g., Temu slider)
function extractInlineCaptchaImages(captchaElement) {
  const extractedImages = [];
  const MIN_IMAGE_SIZE = 50; // Minimum dimension to consider (filter out tiny icons)
  const MIN_DATA_LENGTH = 500; // Minimum base64 length (filter out tiny images)

  // 1. Find all <img> elements with data: URLs
  const inlineImages = captchaElement.querySelectorAll('img[src^="data:image"]');
  for (const img of inlineImages) {
    try {
      const rect = img.getBoundingClientRect();
      // Filter out small icons/UI elements
      if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE) {
        const dataUrl = img.src;
        // Validate it's a real data URL with substantial content
        if (dataUrl.length >= MIN_DATA_LENGTH) {
          extractedImages.push({
            type: 'inline-image',
            dataUrl: dataUrl,
            width: rect.width,
            height: rect.height,
            selector: getCssSelector(img),
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (e) {
      console.warn("[CAPLOG] Error extracting inline image:", e);
    }
  }

  // 2. Find all <canvas> elements and capture their content
  const canvasElements = captchaElement.querySelectorAll('canvas');
  for (const canvas of canvasElements) {
    try {
      const rect = canvas.getBoundingClientRect();
      // Filter out small canvases
      if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE) {
        // Try to capture canvas content (may fail due to tainted canvas)
        try {
          const dataUrl = canvas.toDataURL('image/png');
          // Check it's not a blank canvas
          if (dataUrl.length >= MIN_DATA_LENGTH) {
            extractedImages.push({
              type: 'canvas',
              dataUrl: dataUrl,
              width: canvas.width,
              height: canvas.height,
              displayWidth: rect.width,
              displayHeight: rect.height,
              selector: getCssSelector(canvas),
              timestamp: new Date().toISOString()
            });
          }
        } catch (taintedErr) {
          // Canvas is tainted (cross-origin content) - can't extract
          console.log("[CAPLOG] Canvas tainted, cannot extract:", getCssSelector(canvas));
        }
      }
    } catch (e) {
      console.warn("[CAPLOG] Error extracting canvas:", e);
    }
  }

  // 3. Also check for background-image data URLs in CSS (some CAPTCHAs use this)
  const elementsWithBg = captchaElement.querySelectorAll('*');
  for (const el of elementsWithBg) {
    try {
      const style = window.getComputedStyle(el);
      const bgImage = style.backgroundImage;
      if (bgImage && bgImage.startsWith('url("data:image')) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= MIN_IMAGE_SIZE && rect.height >= MIN_IMAGE_SIZE) {
          // Extract the data URL from url("...")
          const match = bgImage.match(/url\("(data:image[^"]+)"\)/);
          if (match && match[1] && match[1].length >= MIN_DATA_LENGTH) {
            extractedImages.push({
              type: 'background-image',
              dataUrl: match[1],
              width: rect.width,
              height: rect.height,
              selector: getCssSelector(el),
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    } catch (e) {}
  }

  return extractedImages;
}

// Scan all detected CAPTCHA elements for inline images
function extractAllInlineCaptchaImages() {
  const allImages = [];
  const seenDataUrls = new Set(); // Deduplicate

  for (const captcha of captchaElements) {
    const images = extractInlineCaptchaImages(captcha.element);
    for (const img of images) {
      // Use truncated hash of dataUrl for deduplication
      const urlKey = img.dataUrl.substring(0, 200);
      if (!seenDataUrls.has(urlKey)) {
        seenDataUrls.add(urlKey);
        allImages.push({
          ...img,
          captchaSelector: captcha.selector,
          frameId: frameId,
          frameUrl: frameUrl,
          frameDepth: frameDepth
        });
      }
    }
  }

  // Send to background if we found any
  if (allImages.length > 0) {
    console.log(`[CAPLOG] Extracted ${allImages.length} inline image(s) from DOM`);
    browser.runtime.sendMessage({
      action: "captcha-inline-images",
      images: allImages
    }).catch(() => {});
  }

  return allImages;
}

// Track if we've had user interaction (required for canvas extraction in Firefox)
let hasUserInteraction = false;

// Listen for user interaction to enable canvas extraction
function setupUserInteractionTracking() {
  const markInteraction = () => {
    if (!hasUserInteraction) {
      hasUserInteraction = true;
      console.log("[CAPLOG] User interaction detected - canvas extraction enabled");
      // Try extracting now that we have interaction
      if (isRecording && captchaElements.length > 0) {
        extractAllInlineCaptchaImages();
      }
    }
  };

  // Track clicks and key presses
  document.addEventListener('click', markInteraction, { once: false, passive: true });
  document.addEventListener('mousedown', markInteraction, { once: false, passive: true });
  document.addEventListener('keydown', markInteraction, { once: false, passive: true });
}

// Initialize interaction tracking
setupUserInteractionTracking();

// MutationObserver for CAPTCHA appearance/disappearance
let captchaObserver = null;

function startCaptchaObserver() {
  if (captchaObserver) return;

  captchaObserver = new MutationObserver((mutations) => {
    const hadCaptcha = captchaElements.length > 0;
    const hasCaptcha = detectCaptchaElements();

    // CAPTCHA appeared - start recording (all frames start)
    if (!hadCaptcha && hasCaptcha && isArmed && !isRecording) {
      if (isTopFrame) {
        console.log("[CAPLOG] ▶ CAPTCHA detected! Starting recording...");
      }
      startRecording();
    }

    // CAPTCHA disappeared - auto-export (top frame only)
    if (hadCaptcha && !hasCaptcha && isRecording && isTopFrame) {
      console.log("[CAPLOG] CAPTCHA removed from DOM - auto-exporting...");
      autoExportAndReset();
    }
  });

  captchaObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "class", "style"]
  });
}

function stopCaptchaObserver() {
  if (captchaObserver) {
    captchaObserver.disconnect();
    captchaObserver = null;
  }
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

  // Only top frame shows indicator
  if (isTopFrame) {
    showRecordingIndicator();
    console.log(`[CAPLOG] ▶ Recording started (top frame)`);
    console.log(`[CAPLOG]   - URL: ${window.location.href}`);
    console.log(`[CAPLOG]   - CAPTCHA elements: ${captchaElements.length}`);
    captchaElements.forEach((c, i) => {
      console.log(`[CAPLOG]   - [${i + 1}] ${c.selector}`);
    });
    resetInactivityTimer();
    startIntervalExportTimer();
  } else {
    console.log(`[CAPLOG] ▶ Recording started (child frame: ${frameUrl.substring(0, 60)}...)`);
  }

  // Notify background
  browser.runtime.sendMessage({
    action: "recording-started",
    frameId: frameId,
    frameDepth: frameDepth,
    isTopFrame: isTopFrame
  }).catch(() => {});
}

function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  document.removeEventListener("mousemove", handleMouseMove);

  if (isTopFrame) {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
    stopIntervalExportTimer();
    hideRecordingIndicator();

    const duration = Date.now() - recordingStartTime;
    console.log(`[CAPLOG] ■ Recording stopped`);
    console.log(`[CAPLOG]   - Duration: ${(duration / 1000).toFixed(1)}s`);
    console.log(`[CAPLOG]   - Local cursor points: ${cursorPoints.length}`);
    console.log(`[CAPLOG]   - Rounds: ${roundCount}`);
  }
}

// ============================================
// Arming
// ============================================

function arm() {
  if (isArmed) return;
  isArmed = true;

  startCaptchaObserver();
  detectCaptchaElements();

  browser.runtime.sendMessage({
    action: "armed-state",
    armed: true,
    frameId: frameId,
    isTopFrame: isTopFrame
  });

  if (isTopFrame) {
    console.log("[CAPLOG] ✓ Armed and monitoring for CAPTCHAs");
    console.log("[CAPLOG]   Continuous mode: will auto-export when CAPTCHA completes");
  }

  // If CAPTCHA already present, start recording
  if (captchaElements.length > 0) {
    if (isTopFrame) {
      console.log("[CAPLOG] ▶ CAPTCHA already present! Starting recording...");
    }
    startRecording();
  }
}

function disarm() {
  if (!isArmed) return;
  isArmed = false;

  if (isRecording) {
    stopRecording();
  }
  stopCaptchaObserver();

  browser.runtime.sendMessage({
    action: "armed-state",
    armed: false,
    frameId: frameId,
    isTopFrame: isTopFrame
  });

  if (isTopFrame) {
    console.log("[CAPLOG] ✗ Disarmed");
  }
}

function toggleArmed() {
  if (isArmed) {
    disarm();
  } else {
    arm();
  }
}

// ============================================
// Export (top frame only)
// ============================================

async function exportSession() {
  if (!isTopFrame) return false; // Only top frame exports

  stopRecording();

  // Check if we have captured images first
  let capturedImageCount = 0;
  try {
    const imgResponse = await browser.runtime.sendMessage({ action: "get-captured-images" });
    capturedImageCount = (imgResponse.images || []).length;
  } catch (e) {}

  // Get aggregated data from background
  let aggregatedData;
  try {
    aggregatedData = await browser.runtime.sendMessage({ action: "get-aggregated-data" });
  } catch (e) {
    console.error("[CAPLOG] Failed to get aggregated data:", e);
    aggregatedData = { cursorPoints: cursorPoints, captchaElements: [] };
  }

  const allCursorPoints = aggregatedData.cursorPoints || cursorPoints;
  const allCaptchaElements = aggregatedData.captchaElements || captchaElements;

  // Require CAPTCHA images to have been captured for export
  // (prevents exporting empty sessions or just UI element detections)
  if (capturedImageCount === 0) {
    console.log("[CAPLOG] Skipping export - no CAPTCHA images captured");
    return false;
  }

  if (allCursorPoints.length === 0 && allCaptchaElements.length === 0) {
    console.log("[CAPLOG] Nothing to export (no cursor data or CAPTCHA elements)");
    return false;
  }

  const duration = allCursorPoints.length > 0
    ? allCursorPoints[allCursorPoints.length - 1].t
    : 0;

  // Group cursor points by frame for analysis
  const frameStats = {};
  allCursorPoints.forEach(p => {
    if (!frameStats[p.frameId]) {
      frameStats[p.frameId] = { count: 0, url: p.frameUrl, depth: p.frameDepth };
    }
    frameStats[p.frameId].count++;
  });

  const sessionData = {
    version: "0.2",
    recordedAt: new Date().toISOString(),
    sourceUrl: window.location.href,
    hostname: window.location.hostname,
    duration: duration,
    rounds: roundCount,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    // Frame hierarchy info
    frames: Object.entries(frameStats).map(([fid, stats]) => ({
      frameId: fid,
      url: stats.url,
      depth: stats.depth,
      cursorPointCount: stats.count
    })),
    captchaElements: allCaptchaElements.map(c => ({
      selector: c.selector,
      rect: c.rect,
      promptText: c.promptText,
      tagName: c.tagName,
      src: c.src,
      frameId: c.frameId,
      frameUrl: c.frameUrl,
      frameDepth: c.frameDepth
    })),
    cursorPoints: allCursorPoints,
    cursorPointCount: allCursorPoints.length
  };

  console.log("[CAPLOG] Exporting session...");
  console.log(`[CAPLOG]   - Total cursor points: ${allCursorPoints.length}`);
  console.log(`[CAPLOG]   - Frames captured: ${Object.keys(frameStats).length}`);
  Object.entries(frameStats).forEach(([fid, stats]) => {
    console.log(`[CAPLOG]     - depth ${stats.depth}: ${stats.count} points (${stats.url.substring(0, 50)}...)`);
  });

  try {
    const response = await browser.runtime.sendMessage({
      action: "export-session",
      data: sessionData
    });

    if (response.success) {
      console.log("[CAPLOG] ✓ Session exported successfully!");
      return true;
    } else {
      console.error("[CAPLOG] ✗ Export failed:", response.error);
      return false;
    }
  } catch (e) {
    console.error("[CAPLOG] ✗ Export error:", e);
    return false;
  }
}

// ============================================
// Visual Indicator (top frame only)
// ============================================

let indicatorEl = null;

function showRecordingIndicator() {
  if (!isTopFrame) return; // Only top frame shows indicator
  if (indicatorEl) return;

  indicatorEl = document.createElement("div");
  indicatorEl.id = "caplog-indicator";
  indicatorEl.innerHTML = `
    <style>
      #caplog-indicator {
        position: fixed;
        top: 10px;
        right: 10px;
        z-index: 999999;
        background: rgba(220, 38, 38, 0.95);
        color: white;
        padding: 8px 14px;
        border-radius: 6px;
        font-family: system-ui, sans-serif;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 10px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        pointer-events: auto;
      }
      #caplog-indicator .dot {
        width: 8px;
        height: 8px;
        background: white;
        border-radius: 50%;
        animation: caplog-blink 1s infinite;
      }
      @keyframes caplog-blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
      #caplog-indicator .info {
        font-size: 10px;
        opacity: 0.8;
      }
    </style>
    <span class="dot"></span>
    <span>Recording CAPTCHA</span>
    <span class="info">(auto-exports)</span>
  `;

  document.body.appendChild(indicatorEl);
}

function hideRecordingIndicator() {
  if (indicatorEl) {
    indicatorEl.remove();
    indicatorEl = null;
  }
}

// ============================================
// Keyboard Shortcuts (top frame only)
// ============================================

document.addEventListener("keydown", (event) => {
  if (!isTopFrame) return; // Only top frame handles shortcuts

  // Ctrl+Shift+E: force export now
  if (event.ctrlKey && event.shiftKey && event.code === "KeyE") {
    event.preventDefault();
    if (isRecording) {
      console.log("[CAPLOG] Manual export triggered");
      exportSession().then(() => {
        if (isArmed) resetRecording();
      });
    }
  }
});

// ============================================
// Message Handling
// ============================================

browser.runtime.onMessage.addListener((message) => {
  // Toggle arm message from background (toolbar click)
  if (message.action === "toggle-arm") {
    toggleArmed();
  }

  // Broadcast: start recording (from background when any frame detects CAPTCHA)
  if (message.action === "broadcast-start-recording") {
    if (isArmed && !isRecording) {
      startRecording();
    }
  }

  // Broadcast: stop recording
  if (message.action === "broadcast-stop-recording") {
    if (isRecording) {
      stopRecording();
    }
  }

  // Track new CAPTCHA images for round counting (top frame only)
  if (message.action === "captcha-image-captured" && isTopFrame) {
    if (message.imageCount > lastImageCount) {
      const newImages = message.imageCount - lastImageCount;
      console.log(`[CAPLOG] Captured ${newImages} new image(s) (total: ${message.imageCount})`);

      // Multiple new images at once = likely new round
      if (isRecording && newImages >= 3) {
        roundCount++;
        console.log(`[CAPLOG] Round ${roundCount} detected`);
      }
      lastImageCount = message.imageCount;

      // Reset inactivity timer when new images arrive
      resetInactivityTimer();
    }
  }
});

// ============================================
// Console API
// ============================================

window.caplog = {
  arm: arm,
  disarm: disarm,
  export: exportSession,
  getData: () => ({
    isArmed,
    isRecording,
    isTopFrame,
    frameId,
    frameDepth,
    cursorPoints: cursorPoints.length,
    captchaElements: captchaElements.map(c => c.selector),
    duration: isRecording ? Date.now() - recordingStartTime : 0,
    rounds: roundCount
  }),
  getFrameInfo: () => ({
    frameId,
    frameUrl,
    frameDepth,
    isTopFrame
  })
};

// ============================================
// Session-Persistent Arming
// ============================================

// On load, check if this tab should already be armed (survives page navigation)
async function checkPersistedArmedState() {
  try {
    const response = await browser.runtime.sendMessage({ action: "get-armed-state" });
    if (response.armed && !isArmed) {
      if (isTopFrame) {
        console.log("[CAPLOG] Restoring armed state from session...");
      }
      arm();
    }
  } catch (e) {
    // Extension context not available (e.g., on privileged pages)
  }
}

// Startup log
if (isTopFrame) {
  console.log("[CAPLOG] Content script loaded (TOP FRAME)");
  console.log("[CAPLOG] Click toolbar button to arm (continuous mode)");
  console.log(`[CAPLOG] Export config: navigation=${EXPORT_CONFIG.onNavigation}, interval=${EXPORT_CONFIG.intervalEnabled ? EXPORT_CONFIG.intervalMs/1000 + 's' : 'off'}, inactivity=${EXPORT_CONFIG.onInactivity}`);

  // Setup navigation-based export (beforeunload handler)
  setupNavigationExport();
} else {
  console.log(`[CAPLOG] Content script loaded (child frame, depth=${frameDepth})`);
}

// Check for persisted armed state (runs after DOM is ready)
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", checkPersistedArmedState);
} else {
  checkPersistedArmedState();
}