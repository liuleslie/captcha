// main.js — Content script injected into every page and every iframe.
// Runs at document_start so it can observe the DOM from the first moment.
//
// Two operating modes depending on frame position:
//   Top frame  — manages recording state, shows the on-page indicator, triggers
//                session saves, and replaces the favicon dot.
//   Child frame — silently tracks cursor position and sends points to the
//                background; all visual/state logic is skipped.
//
// Data flow:
//   detect CAPTCHA → startRecording → collect cursor + images
//   → saveSession → background.js (IndexedDB) → sidebar archive

// ============================================
// Frame Detection
// ============================================

// isTopFrame distinguishes the main page from embedded iframes.
// CAPTCHA challenge content (e.g. reCAPTCHA grid, Arkose puzzle) typically
// lives in a child iframe, so we track depth and URL for every frame.
const isTopFrame  = (window === window.top);
const frameId     = Math.random().toString(36).slice(2, 10); // stable for this frame's lifetime
const frameUrl    = window.location.href;
const frameDepth  = (() => {
  let depth = 0, win = window;
  while (win !== win.top) { depth++; win = win.parent; }
  return depth;
})();

// ============================================
// State
// ============================================

// isMonitoring: set once when consent is confirmed; enables DOM observation.
// isRecording:  set when a CAPTCHA is detected; enables cursor tracking + saves.
let isMonitoring        = false;
let isRecording         = false;
let recordingStartTime  = 0;
let cursorPoints        = []; // cursor trace for this frame (sent to background each mousemove)
let captchaElements     = []; // detected CAPTCHA containers, populated by detectCaptchaElements()
let roundCount          = 0;  // incremented when ≥3 new images arrive (heuristic for new challenge round)
let lastImageCount      = 0;  // tracks background image count to detect new rounds
let lastCursorTime      = 0;  // last time cursor was over a CAPTCHA element
let intervalExportTimer = null;
let lastInlineExtractionTime = 0; // throttle DOM image extraction to once per 2 s
let _captchaDisappearTimer = null; // grace period before treating disappearance as genuine

// Save triggers: navigation (beforeunload), interval backup, or CAPTCHA disappearance.
const EXPORT_CONFIG = {
  onNavigation:    true,
  intervalEnabled: true,
  intervalMs:      60000  // 60-second backup save
};

// ============================================
// Favicon Injection (top frame only)
// ============================================
// We replace the tab favicon with a coloured dot to show recording state:
//   gray dot → monitoring (waiting for CAPTCHA)
//   red dot  → recording (CAPTCHA detected)
// A MutationObserver on <head> keeps our dot as the last <link rel="icon">
// so the page can't silently push its own favicon back on top of ours.

let originalFaviconHref = null;
let injectedFaviconLink = null;
let faviconObserver     = null;

function saveFavicon() {
  if (!isTopFrame) return;
  const el = document.querySelector('link[rel~="icon"]');
  originalFaviconHref = el ? el.href : null;
}

// Called by the MutationObserver whenever <head> children change.
// Re-appends our dot link if the page has moved it out of last position.
function _assertFaviconPosition() {
  if (!injectedFaviconLink || !document.head) return;
  const links = document.head.querySelectorAll('link[rel~="icon"]');
  if (!links.length || links[links.length - 1] !== injectedFaviconLink) {
    document.head.appendChild(injectedFaviconLink);
  }
}

function setFaviconDot(state) { // state: "gray" | "red" | "restore"
  if (!isTopFrame) return;

  // Null injectedFaviconLink BEFORE removing the old element so that the
  // faviconObserver callback short-circuits and doesn't re-insert the old link.
  const old = injectedFaviconLink;
  injectedFaviconLink = null;
  if (old) old.remove();

  if (state === "restore") {
    if (faviconObserver) { faviconObserver.disconnect(); faviconObserver = null; }
    return; // browser falls back to the page's own <link rel="icon">
  }

  // Always create a fresh <link> element; some browsers ignore pure href mutations.
  injectedFaviconLink = document.createElement("link");
  injectedFaviconLink.rel = "icon";
  injectedFaviconLink.id  = "captcha-diary-favicon";
  try {
    injectedFaviconLink.href = browser.runtime.getURL(`icons/dot-${state}.png`);
  } catch (e) {}
  document.head.appendChild(injectedFaviconLink);

  // Watch for future page-initiated changes that might dislodge our dot.
  if (!faviconObserver && document.head) {
    faviconObserver = new MutationObserver(_assertFaviconPosition);
    faviconObserver.observe(document.head, { childList: true });
  }
}

// ============================================
// Cursor Tracking
// ============================================
// Every mousemove during a recording session adds a point to cursorPoints
// and forwards it to background.js for cross-frame aggregation.
// The overCaptcha flag marks whether the cursor is inside a detected
// CAPTCHA bounding box — useful for downstream behavioural analysis.

function handleMouseMove(event) {
  if (!isRecording) return;

  const now = Date.now();
  const overCaptcha = isOverCaptcha(event.clientX, event.clientY);

  const point = {
    x: event.clientX,
    y: event.clientY,
    t: now - recordingStartTime, // milliseconds since recording started
    overCaptcha,
    frameId,
    frameUrl,
    frameDepth
  };

  cursorPoints.push(point);
  browser.runtime.sendMessage({ action: "cursor-point", point }).catch(() => {});

  // While the cursor is over a CAPTCHA, attempt a DOM image extraction every 2 s.
  // This catches canvas-rendered challenges that appear after user interaction.
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

// Returns true if (x, y) falls inside any known CAPTCHA element's bounding box.
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
// Belt-and-suspenders: saves every 60 s if recording is still active.
// The primary saves are triggered by CAPTCHA disappearance or page navigation.

function startIntervalExportTimer() {
  if (!isTopFrame || !EXPORT_CONFIG.intervalEnabled) return;
  stopIntervalExportTimer();
  intervalExportTimer = setInterval(() => {
    if (isRecording && cursorPoints.length > 0) {
      console.log("[DIARY] Interval save triggered...");
      // resetRecording() clears state after save so that if the CAPTCHA is still
      // visible the MutationObserver can restart recording on the next mutation.
      // Without this, stopRecording() (called inside saveSession) hides the badge
      // and sets isRecording=false, but captchaElements stays non-empty, so the
      // "0 → N" observer trigger never fires and recording never restarts.
      saveSession("interval").then(() => resetRecording());
    }
  }, EXPORT_CONFIG.intervalMs);
}

function stopIntervalExportTimer() {
  if (intervalExportTimer) { clearInterval(intervalExportTimer); intervalExportTimer = null; }
}

// ============================================
// Navigation-Based Save (beforeunload)
// ============================================
// Fires when the user navigates away or closes the tab.
// beforeunload is fire-and-forget (no await); visibilitychange is more reliable
// for tab switches / backgrounding and allows async save.

function setupNavigationExport() {
  if (!isTopFrame || !EXPORT_CONFIG.onNavigation) return;

  window.addEventListener("beforeunload", () => {
    if (isRecording && cursorPoints.length > 0) {
      browser.runtime.sendMessage({
        action: "save-session",
        data: buildSessionData("navigation")
      }).catch(() => {});
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isRecording && cursorPoints.length > 0) {
      // resetRecording() after save so that when the user returns, detectCaptchaElements()
      // starts fresh and the "visible" handler below can restart recording cleanly.
      saveSession("visibility-hidden").then(() => resetRecording());
    }
    if (document.visibilityState === "visible" && !isRecording && isMonitoring) {
      // User returned to the tab — re-check if a CAPTCHA is still present and restart.
      if (detectCaptchaElements()) {
        console.log("[DIARY] Returned to tab with CAPTCHA present — restarting recording...");
        startRecording();
      }
    }
  });
}

// ============================================
// CAPTCHA Detection
// ============================================
// Two-pass detection strategy:
//   Pass 1 — CSS selector matching against known provider patterns (high precision).
//   Pass 2 — text-content pattern matching for providers not covered by selectors
//             (e.g. custom slider or verification widgets).
// Results populate captchaElements[], which drives cursor hit-testing and
// image extraction scope.

// Selectors are split into two tiers:
//
//   SPECIFIC — iframe src and named class patterns; high confidence, accepted as-is.
//   BROAD    — generic substring matches on id/class; require extra validation via
//              isValidBroadCandidate() to avoid matching search-result links,
//              context-menu items, or navigation elements that happen to contain
//              the word "captcha" or "verification" in their id/class.
//
// The DuckDuckGo false-positive case illustrates why this split is needed:
//   a search for "funcaptcha" produces context-menu elements with IDs like
//   #contextMenu-2captcha.com/p/funcaptcha — a URL embedded in an id attribute,
//   matched by [id*="captcha"] but clearly not a CAPTCHA widget.

// SPECIFIC: only iframe[src*=...] patterns and canonical provider class names / IDs.
// These are high-confidence because:
//   - iframe src attributes are controlled by the embedding site's code, not user content
//   - Canonical classes (.g-recaptcha, .h-captcha, .cf-turnstile) are the exact
//     integration classes documented by each provider — they appear only on the widget
//
// IMPORTANT: [class*="..."] substring patterns are NOT here, even for provider names.
// On provider-domain sites (hcaptcha.com, 2captcha.com) and sites about CAPTCHAs,
// provider names appear in nav links, service icons, SVGs, and marketing copy.
// All such patterns live in CAPTCHA_SELECTORS_BROAD and require isValidBroadCandidate().
const CAPTCHA_SELECTORS_SPECIFIC = [
  // Provider iframes — src hostname will be further validated in JS (see detectCaptchaElements)
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare"]', 'iframe[src*="turnstile"]',
  'iframe[src*="geetest"]',
  'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
  'iframe[src*="datadome"]',
  'iframe[src*="perimeterx"]',
  // Canonical integration classes — used only on the actual widget container element
  '.g-recaptcha',   // reCAPTCHA v2 documented integration class
  '.h-captcha',     // hCaptcha documented integration class
  '.cf-turnstile',  // Turnstile documented integration class
  '.geetest_panel', '.geetest_widget',  // GeeTest SDK-generated classes
  // Specific IDs set by provider SDKs
  '#FunCaptcha',    // Arkose FunCaptcha
  '#keycaptcha',    // KeyCAPTCHA
];

// BROAD: all substring class/id patterns — every match is validated by isValidBroadCandidate().
// These can appear on logos, nav icons, marketing copy, and service-listing pages.
const CAPTCHA_SELECTORS_BROAD = [
  // Provider name substrings (appear in branding and editorial content, not just widgets)
  '[class*="recaptcha"]', '[id*="recaptcha"]',
  '[class*="hcaptcha"]',
  '[class*="turnstile"]',
  '[class*="geetest"]',
  '[class*="funcaptcha"]', '[class*="arkose"]',
  '[class*="datadome"]',
  '[class*="perimeterx"]', '[class*="px-captcha"]',
  '[class*="keycaptcha"]',
  // Slider / drag-verify widget patterns
  '[class*="slider-wrapper"]', '[class*="slider_wrapper"]', '[class*="slide-verify"]', '[class*="slideverify"]',
  '[class*="slider-captcha"]', '[class*="slide_captcha"]', '[class*="drag-verify"]', '[class*="puzzle-captcha"]',
  // Generic (broadest — most false-positive-prone, most strictly validated)
  '[class*="captcha"]', '[id*="captcha"]',
  '[class*="verification"]', '[id*="verification"]',
  '#verification', '[class*="verify-wrap"]', '[class*="verify_wrap"]',
  '[class*="slider-verify"]', '[class*="slider_verify"]', '[class*="captcha-slider"]', '[class*="captcha_slider"]',
  '[class*="security-check"]', '[class*="security_check"]', '[class*="bot-check"]', '[class*="human-verify"]'
];

// Tags that are never CAPTCHA widget containers.
// SVG — icons, illustrations, logos; always decorative/presentational
// A, LI, UL, OL, NAV, MENU — navigation and list elements
// HEADER, FOOTER, ASIDE — layout chrome
// OPTION — form option element
const NON_WIDGET_TAGS = new Set([
  "A", "LI", "UL", "OL", "NAV", "MENU", "HEADER", "FOOTER", "ASIDE", "OPTION", "SVG"
]);

// Known CAPTCHA provider hostnames used to validate iframe src attributes.
// CSS attribute selectors match the full src string, including query parameters —
// an analytics-tagged embed like youtube.com/embed/x?source=hcaptcha would match
// iframe[src*="hcaptcha"]. Checking the actual hostname prevents this.
const KNOWN_PROVIDER_HOSTNAMES = [
  "google.com", "recaptcha.net", "gstatic.com",
  "hcaptcha.com", "newassets.hcaptcha.com", "imgs.hcaptcha.com", "api2.hcaptcha.com",
  "challenges.cloudflare.com",
  "geetest.com", "geevisit.com",
  "arkoselabs.com", "funcaptcha.com", "client-api.arkoselabs.com",
  "datadome.co", "dd.datadome.co",
  "perimeterx.net", "px-cdn.net",
  "keycaptcha.com"
];

function isKnownProviderHostname(hostname) {
  return KNOWN_PROVIDER_HOSTNAMES.some(d => hostname === d || hostname.endsWith("." + d));
}

// Matches an id attribute that encodes a URL (e.g. "contextMenu-2captcha.com/path").
// Pattern: a dot followed by 2–6 lowercase letters followed by a slash.
const URL_LIKE_ID_RE = /\.[a-z]{2,6}\//;

// Extra validation applied to every element matched by CAPTCHA_SELECTORS_BROAD.
// Returns false if the element looks like navigation, a service-listing section,
// a provider logo, or any other non-widget DOM node.
function isValidBroadCandidate(el) {
  // Navigation / structural / decorative elements are never widget containers.
  if (NON_WIDGET_TAGS.has(el.tagName)) return false;
  // A URL-encoded id (e.g. search-engine context menu items) is not a widget.
  if (el.id && URL_LIKE_ID_RE.test(el.id)) return false;
  // A genuine CAPTCHA widget is interactive — it contains an iframe, button,
  // canvas, or visible input. A content section or logo element does not.
  if (!hasInteractiveDescendant(el)) return false;
  // Size constraint: CAPTCHA widgets are components, not page sections.
  // A full-width service-listing section (#order-captchas, etc.) exceeds this cap.
  // Real CAPTCHA widgets max out at ~600px wide (reCAPTCHA grid, Arkose challenge).
  const rect = el.getBoundingClientRect();
  if (rect.width > 700) return false;
  return true;
}

// Builds a short, stable CSS selector for a DOM element.
// Used for logging and session metadata — not for re-querying the DOM.
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


// Text patterns that appear in actual CAPTCHA widgets (not articles about them).
// /captcha/i is deliberately excluded — it matches pages discussing CAPTCHAs.
const CAPTCHA_TEXT_PATTERNS = [
  /verify\s*you.*human/i, /are\s*you.*robot/i,
  /prove\s*you.*human/i, /slide\s*to\s*verify/i, /drag.*puzzle/i,
  /human\s*verification/i, /bot\s*protection/i,
  /security\s*verification/i, /security\s*check/i,
  /complete.*verification/i, /verification.*required/i
];

// Editorial/informational text that would produce false positives.
// Applied to the matched element before walking up to a container.
const BLACKLIST_TEXT_PATTERNS = [
  /how to/i, /about/i, /tutorial/i, /article/i, /guide/i, /definition/i, /example/i
];

// Returns true if the element (or any ancestor up to 3 levels) contains at
// least one interactive child — iframes, buttons, canvases, or visible inputs.
// CAPTCHA widgets are always interactive components; a bare text label on an
// informational page has no such children, so this rules out false positives.
function hasInteractiveDescendant(el) {
  return !!el.querySelector('iframe, button, canvas, input:not([type="hidden"]), select');
}

// Text-based fallback detector: walks div/span/label text nodes, matches
// against CAPTCHA_TEXT_PATTERNS, then climbs the DOM to find a plausible
// widget container.
function findCaptchaByText() {
  const found = [];
  const candidates = document.querySelectorAll("div, span, label");
  for (const el of candidates) {
    const text = el.textContent?.trim() || "";

    // Skip educational/editorial text that matches CAPTCHA patterns by accident.
    if (BLACKLIST_TEXT_PATTERNS.some(p => p.test(text))) continue;

    // CAPTCHA prompt labels are short; longer text is almost certainly editorial.
    if (text.length > 100) continue;

    for (const pattern of CAPTCHA_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        // Walk up to find a reasonably-sized container that looks like a widget.
        let container = el.parentElement;
        let depth = 0;
        while (container && depth < 5) {
          const rect = container.getBoundingClientRect();
          // Widget size constraints: must be a visible component, not a full-width
          // page section. 600px cap prevents matching article body containers.
          if (rect.width > 100 && rect.height > 100 &&
              rect.width < 600 && rect.height < window.innerHeight * 0.9) {
            // Only accept containers that have interactive children — this is
            // the key guard against matching logos or static text banners.
            if (hasInteractiveDescendant(container)) {
              found.push(container);
            }
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

// Main detection function — called on page load and on every DOM mutation.
// Populates captchaElements[] and notifies the background of what was found.
// Returns true if any CAPTCHA elements were detected.
function detectCaptchaElements() {
  captchaElements = [];
  const seenElements = new Set();

  // --- Pass 1a: Specific selectors (high confidence) ---
  // Even specific selectors receive basic tag filtering and, for iframes,
  // hostname validation — provider names can appear on their own marketing sites
  // in contexts that look like widgets but aren't (logos, nav icons, demo sections).
  for (const selector of CAPTCHA_SELECTORS_SPECIFIC) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (seenElements.has(el)) continue;
        if (el.id && el.id.startsWith("captcha-diary-")) continue;
        // Skip decorative / structural tags that are never widget containers.
        // IMG, SVG — icons and logos; A, LI, NAV etc. — navigation elements.
        if (el.tagName === "IMG" || NON_WIDGET_TAGS.has(el.tagName)) continue;
        // For iframes: verify the src hostname is a known provider domain.
        // CSS [src*="hcaptcha"] matches anywhere in the URL string, including
        // query params like ?ref=hcaptcha in an unrelated marketing video embed.
        if (el.tagName === "IFRAME" && el.src) {
          try {
            if (!isKnownProviderHostname(new URL(el.src).hostname)) continue;
          } catch (e) { continue; }
        }
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          seenElements.add(el);
          captchaElements.push({
            element: el,
            selector: getCssSelector(el),
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
            promptText:      null,
            tagName:         el.tagName.toLowerCase(),
            src:             el.src || null,
            frameId, frameUrl, frameDepth,
            detectionMethod: "selector"
          });
        }
      }
    } catch (e) {}
  }

  // --- Pass 1b: Broad selectors (lower confidence; extra validation required) ---
  for (const selector of CAPTCHA_SELECTORS_BROAD) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        if (seenElements.has(el)) continue;
        if (el.id && el.id.startsWith("captcha-diary-")) continue;
        if (el.tagName === "IMG") continue;
        // isValidBroadCandidate() rejects navigation elements, URL-embedded ids,
        // and elements without interactive children (e.g. DDG context-menu items).
        if (!isValidBroadCandidate(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          seenElements.add(el);
          captchaElements.push({
            element: el,
            selector: getCssSelector(el),
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
            promptText:      null,
            tagName:         el.tagName.toLowerCase(),
            src:             el.src || null,
            frameId, frameUrl, frameDepth,
            detectionMethod: "selector-broad"
          });
        }
      }
    } catch (e) {}
  }

  // --- Pass 2: text-content matching (fallback for unrecognised providers) ---
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
          promptText:      extractPromptText(el),
          tagName:         el.tagName.toLowerCase(),
          src:             el.src || null,
          frameId, frameUrl, frameDepth,
          detectionMethod: "text-content"
        });
      }
    }
  } catch (e) {}

  if (captchaElements.length > 0) {
    // Report detected elements to the background for aggregation across frames.
    browser.runtime.sendMessage({
      action: "captcha-elements",
      elements: captchaElements.map(c => ({
        selector: c.selector, rect: c.rect, promptText: c.promptText,
        tagName: c.tagName, src: c.src, frameId: c.frameId, frameUrl: c.frameUrl, frameDepth: c.frameDepth
      }))
    }).catch(() => {});
    // Attempt an immediate DOM image extraction for any already-rendered content.
    extractAllInlineCaptchaImages();
  }

  // Draw (or clear) 1px red outlines around each detected element in the top frame.
  updateCaptchaOutlines();

  return captchaElements.length > 0;
}

// ============================================
// DOM-Based Image Extraction
// ============================================
// Complements the network interceptor in background.js. Captures images that
// are rendered directly into the DOM rather than loaded over the network:
//   • inline <img src="data:image/..."> — some providers inline small tiles
//   • <canvas> snapshots — Arkose and some sliders render puzzles to canvas
//   • CSS background-image with data URL — uncommon but seen in some widgets
//
// Guards against capturing branding/logo assets:
//   MIN_IMAGE_SIZE  — logos are typically <40px; challenge tiles are ≥80px
//   Aspect ratio    — logos are often wide/narrow; tiles are roughly square
//   Logo-class skip — elements whose class/id signals they are UI chrome

const MIN_IMAGE_SIZE   = 80;   // px — minimum width AND height for challenge media
const MIN_DATA_LENGTH  = 500;  // chars — minimum base64 data URL length
const MAX_ASPECT_RATIO = 4;    // reject if max(w,h)/min(w,h) > 4 (logo-shaped)

// CSS class/id patterns that indicate a branding or decorative element.
const LOGO_CLASS_RE = /logo|brand|watermark|badge|branding|icon-wrap/i;

function isLogoElement(el) {
  const cls = (el.className && typeof el.className === "string") ? el.className : "";
  return LOGO_CLASS_RE.test(cls) || LOGO_CLASS_RE.test(el.id || "");
}

// Returns true if the image dimensions suggest a logo (very wide/short or tall/narrow).
function isLogoShaped(width, height) {
  if (width === 0 || height === 0) return true;
  return (Math.max(width, height) / Math.min(width, height)) > MAX_ASPECT_RATIO;
}

function extractInlineCaptchaImages(captchaElement) {
  const extractedImages = [];

  // --- Inline <img src="data:image/..."> ---
  const inlineImages = captchaElement.querySelectorAll('img[src^="data:image"]');
  for (const img of inlineImages) {
    try {
      if (isLogoElement(img)) continue;
      const rect = img.getBoundingClientRect();
      if (rect.width  < MIN_IMAGE_SIZE) continue;
      if (rect.height < MIN_IMAGE_SIZE) continue;
      if (isLogoShaped(rect.width, rect.height)) continue;
      if (img.src.length < MIN_DATA_LENGTH) continue;
      extractedImages.push({
        type: "inline-image", dataUrl: img.src,
        width: rect.width, height: rect.height,
        selector: getCssSelector(img), timestamp: new Date().toISOString()
      });
    } catch (e) {}
  }

  // --- <canvas> elements (Arkose, slider puzzles) ---
  const canvasElements = captchaElement.querySelectorAll("canvas");
  for (const canvas of canvasElements) {
    try {
      if (isLogoElement(canvas)) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width  < MIN_IMAGE_SIZE) continue;
      if (rect.height < MIN_IMAGE_SIZE) continue;
      if (isLogoShaped(rect.width, rect.height)) continue;
      try {
        const dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length < MIN_DATA_LENGTH) continue;
        extractedImages.push({
          type: "canvas", dataUrl,
          width: canvas.width, height: canvas.height,
          displayWidth: rect.width, displayHeight: rect.height,
          selector: getCssSelector(canvas), timestamp: new Date().toISOString()
        });
      } catch (e) {
        // canvas.toDataURL throws SecurityError for cross-origin-tainted canvases
      }
    } catch (e) {}
  }

  // --- CSS background-image with data URL ---
  const elementsWithBg = captchaElement.querySelectorAll("*");
  for (const el of elementsWithBg) {
    try {
      if (isLogoElement(el)) continue;
      const style    = window.getComputedStyle(el);
      const bgImage  = style.backgroundImage;
      if (!bgImage || !bgImage.startsWith('url("data:image')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width  < MIN_IMAGE_SIZE) continue;
      if (rect.height < MIN_IMAGE_SIZE) continue;
      if (isLogoShaped(rect.width, rect.height)) continue;
      const match = bgImage.match(/url\("(data:image[^"]+)"\)/);
      if (!match || !match[1] || match[1].length < MIN_DATA_LENGTH) continue;
      extractedImages.push({
        type: "background-image", dataUrl: match[1],
        width: rect.width, height: rect.height,
        selector: getCssSelector(el), timestamp: new Date().toISOString()
      });
    } catch (e) {}
  }

  return extractedImages;
}

// Runs extractInlineCaptchaImages() across all detected CAPTCHA containers,
// deduplicates by the first 200 chars of the data URL, and forwards unique
// images to the background for storage.
function extractAllInlineCaptchaImages() {
  const allImages   = [];
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

// hasUserInteraction is set on the first click, mousedown, or keydown.
// DOM image extraction is deferred until the user has interacted, because
// canvas-rendered challenges often don't appear until the widget is clicked.
let hasUserInteraction = false;

function setupUserInteractionTracking() {
  const markInteraction = () => {
    if (!hasUserInteraction) {
      hasUserInteraction = true;
      if (isRecording && captchaElements.length > 0) extractAllInlineCaptchaImages();
    }
  };
  document.addEventListener("click",     markInteraction, { passive: true });
  document.addEventListener("mousedown", markInteraction, { passive: true });
  document.addEventListener("keydown",   markInteraction, { passive: true });
}

setupUserInteractionTracking();

// ============================================
// MutationObserver
// ============================================
// Watches the DOM for CAPTCHA elements appearing or disappearing dynamically.
// Fires detectCaptchaElements() on each mutation; the before/after comparison
// of captchaElements.length drives the recording lifecycle:
//   0 → N elements: startRecording()
//   N → 0 elements: saveSession() + resetRecording()

let captchaObserver = null;

// Fast pre-screen regex: keywords that appear in the class or id of a CAPTCHA
// widget container. Used to avoid calling detectCaptchaElements() on mutations
// that have no chance of being CAPTCHA-related (e.g. Discord message bubbles,
// React state toggles, animation frames).
const CAPTCHA_MUTATION_RE = /captcha|hcaptcha|recaptcha|turnstile|geetest|funcaptcha|arkose|datadome|perimeterx/i;

function startCaptchaObserver() {
  if (captchaObserver) return;
  let _debounceTimer = null;

  captchaObserver = new MutationObserver((mutations) => {
    // Skip batches consisting entirely of our own overlay elements (outline divs,
    // indicator, favicon link). Without this guard, updateCaptchaOutlines() causes
    // a feedback loop: DOM change → observer fires → detectCaptchaElements →
    // updateCaptchaOutlines → DOM change → … at full CPU speed.
    const relevant = mutations.some(m => {
      if (m.type === "childList") {
        for (const node of [...m.addedNodes, ...m.removedNodes]) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (!(node.id || "").startsWith("captcha-diary-") &&
              !(typeof node.className === "string" && node.className.startsWith("captcha-diary-")))
            return true;
        }
        return false;
      }
      // attribute mutation: check if the target is one of our injected elements
      return !(m.target.id || "").startsWith("captcha-diary-");
    });
    if (!relevant) return;

    // Performance guard: when not actively recording, skip the expensive
    // detectCaptchaElements() pass unless the mutations actually contain
    // something that could be a CAPTCHA widget. This prevents heavy SPAs
    // (Discord, Gmail, Twitter) from triggering full DOM scans on every
    // React re-render, hover state, message insertion, or animation frame.
    // When recording, always proceed — we need to detect when the CAPTCHA disappears.
    if (!isRecording) {
      const mightBeCaptcha = mutations.some(m => {
        if (m.type === "childList") {
          for (const node of [...m.addedNodes, ...m.removedNodes]) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.tagName === "IFRAME") return true; // any new/removed iframe warrants a check
            const cls = typeof node.className === "string" ? node.className : "";
            if (CAPTCHA_MUTATION_RE.test(cls) || CAPTCHA_MUTATION_RE.test(node.id || "")) return true;
          }
          return false;
        }
        if (m.type === "attributes" && m.attributeName === "src") return true; // iframe src swap
        if (m.type === "attributes" && m.attributeName === "class") {
          const cls = typeof m.target.className === "string" ? m.target.className : "";
          return CAPTCHA_MUTATION_RE.test(cls);
        }
        return false;
      });
      if (!mightBeCaptcha) return;
    }

    // Debounce: coalesce rapid-fire mutations (e.g. SPA route changes, animated
    // widgets) into a single detection pass to keep CPU usage low.
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      const hadCaptcha = captchaElements.length > 0;
      const hasCaptcha = detectCaptchaElements();

      if (!hadCaptcha && hasCaptcha && isMonitoring && !isRecording) {
        if (isTopFrame) console.log("[DIARY] CAPTCHA detected — starting recording...");
        startRecording();
      }

      if (hasCaptcha && _captchaDisappearTimer !== null) {
        // CAPTCHA came back before the grace period expired — false alarm, keep recording.
        clearTimeout(_captchaDisappearTimer);
        _captchaDisappearTimer = null;
        console.log("[DIARY] CAPTCHA reappeared — continuing recording...");
      }

      if (hadCaptcha && !hasCaptcha && isRecording && isTopFrame) {
        // Don't save immediately — some providers (e.g. hCaptcha) briefly remove the
        // challenge element between rounds. Wait 2s; if still gone it's genuine.
        if (_captchaDisappearTimer === null) {
          console.log("[DIARY] CAPTCHA gone — waiting 2s to confirm...");
          _captchaDisappearTimer = setTimeout(() => {
            _captchaDisappearTimer = null;
            if (!detectCaptchaElements() && isRecording) {
              console.log("[DIARY] CAPTCHA removed from DOM — saving session...");
              browser.runtime.sendMessage({ action: "captcha-disappeared", isTopFrame: true }).catch(() => {});
              saveSession("captcha-disappeared").then(() => resetRecording());
            }
          }, 2000);
        }
      }
    }, 100);
  });

  // Watch src/class attribute changes as well as child insertions/removals.
  // "style" is intentionally excluded: style changes fire constantly on
  // animated SPAs (hover states, transitions, React re-renders) and are
  // never how CAPTCHA providers reveal their widgets — providers inject
  // iframes (childList) or swap iframe src / class attributes.
  captchaObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "class"]
  });
}

function stopCaptchaObserver() {
  if (captchaObserver) { captchaObserver.disconnect(); captchaObserver = null; }
}

// ============================================
// Recording Control
// ============================================
// startRecording — called when a CAPTCHA is first detected.
// stopRecording  — called before a save; halts cursor collection.
// resetRecording — called after a successful save; clears all buffers.

function startRecording() {
  if (isRecording) return;
  isRecording        = true;
  recordingStartTime = Date.now();
  cursorPoints       = [];
  roundCount         = 1;
  lastImageCount     = 0;
  lastCursorTime     = Date.now();

  detectCaptchaElements(); // re-run now that recording has begun
  document.addEventListener("mousemove", handleMouseMove);

  // Notify background to update the toolbar badge.
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
  if (_captchaDisappearTimer !== null) {
    clearTimeout(_captchaDisappearTimer);
    _captchaDisappearTimer = null;
  }
  cursorPoints    = [];
  captchaElements = [];
  roundCount      = 0;
  lastImageCount  = 0;
  lastCursorTime  = 0;
  isRecording     = false;
  clearCaptchaOutlines();
  browser.runtime.sendMessage({ action: "clear-cursor-data" }).catch(() => {});
  if (isTopFrame) console.log("[DIARY] Reset — waiting for next CAPTCHA...");
}

// ============================================
// Monitoring Activation
// ============================================
// startMonitoring() is the entry point for the extension's active phase.
// It is called once consent is confirmed (via background.js message or
// check-consent response). Before this point the content script is inert.

function startMonitoring() {
  if (isMonitoring) return;
  isMonitoring = true;

  if (isTopFrame) {
    console.log("[DIARY] Monitoring active (top frame)");
  } else {
    console.log(`[DIARY] Monitoring active (child frame depth=${frameDepth})`);
  }

  // document.body may not exist yet at document_start injection time.
  // Defer DOM work until it is available.
  if (document.body) {
    _beginObservingDOM();
  } else {
    document.addEventListener("DOMContentLoaded", _beginObservingDOM, { once: true });
  }
}

function _beginObservingDOM() {
  if (isTopFrame) {
    saveFavicon();
    setFaviconDot("gray"); // show that monitoring is active even before a CAPTCHA appears
  }

  startCaptchaObserver();
  detectCaptchaElements();

  // If a CAPTCHA was already in the DOM when monitoring started (e.g. page loaded
  // directly to a challenge), begin recording immediately.
  if (captchaElements.length > 0) {
    if (isTopFrame) console.log("[DIARY] CAPTCHA already present — starting recording...");
    startRecording();
  }

}


// ============================================
// Session Save
// ============================================
// buildSessionData() assembles a snapshot of the current recording state.
// saveSession() is the full async pipeline: stop → check images exist →
// fetch aggregated data from background → send save request → return result.
//
// Only the top frame calls saveSession(). Child frames only contribute
// cursor points and image data via background.js message handlers.

// Parses navigator.userAgent to return a structured browser identity object.
// Stored in every session record so captures can be grouped/filtered by
// browser in the archive, and compared across collection runs.
function detectBrowserInfo() {
  const ua = navigator.userAgent;
  let name    = "Unknown";
  let version = "";

  // Use explicit capture groups; RegExp.$1 is deprecated.
  // Order matters: Edge and Chrome share UA substrings, so check Edge first.
  let m;
  if      ((m = ua.match(/Edg\/(\d+)/)))              { name = "Edge";    version = m[1]; }
  else if ((m = ua.match(/Firefox\/(\d+)/)))          { name = "Firefox"; version = m[1]; }
  else if ((m = ua.match(/OPR\/(\d+)/)))              { name = "Opera";   version = m[1]; }
  else if ((m = ua.match(/Chrome\/(\d+)/)))           { name = "Chrome";  version = m[1]; }
  else if ((m = ua.match(/Version\/(\d+).*Safari/)))  { name = "Safari";  version = m[1]; }

  // navigator.userAgentData.platform is the modern replacement for navigator.platform.
  // Fall back to the UA string for browsers that don't expose userAgentData yet.
  const platform = navigator.userAgentData?.platform
    || (ua.includes("Win") ? "Windows" : ua.includes("Mac") ? "macOS"
        : ua.includes("Linux") ? "Linux" : ua.includes("Android") ? "Android"
        : ua.includes("iPhone") || ua.includes("iPad") ? "iOS" : "");

  return {
    name,
    version,
    label:    version ? `${name} ${version}` : name, // short display string, e.g. "Firefox 130"
    userAgent: ua,
    platform,
    language:  navigator.language  || "",
    cookiesEnabled: navigator.cookieEnabled,
    screenWidth:    window.screen ? window.screen.width  : null,
    screenHeight:   window.screen ? window.screen.height : null,
  };
}

// Computed once at recording time; reused in buildSessionData and the indicator.
let _browserInfo = null;
function getBrowserInfo() {
  if (!_browserInfo) _browserInfo = detectBrowserInfo();
  return _browserInfo;
}

function buildSessionData(trigger) {
  const allCursorPoints = cursorPoints;
  // Use the timestamp of the last cursor point as session duration.
  const duration = allCursorPoints.length > 0 ? allCursorPoints[allCursorPoints.length - 1].t : 0;

  // Summarise cursor point counts per frame for the session metadata.
  const frameStats = {};
  allCursorPoints.forEach(p => {
    if (!frameStats[p.frameId]) frameStats[p.frameId] = { count: 0, url: p.frameUrl, depth: p.frameDepth };
    frameStats[p.frameId].count++;
  });

  return {
    recordedAt:  new Date(recordingStartTime).toISOString(),
    sourceUrl:   window.location.href,
    hostname:    window.location.hostname,
    duration,
    rounds:      roundCount,
    viewport:    { width: window.innerWidth, height: window.innerHeight },
    // Full browser identity — useful for filtering sessions by UA and debugging
    // detection differences across browser engines.
    browser:     getBrowserInfo(),
    frames:      Object.entries(frameStats).map(([fid, stats]) => ({
      frameId: fid, url: stats.url, depth: stats.depth, cursorPointCount: stats.count
    })),
    captchaElements: captchaElements.map(c => ({
      selector: c.selector, rect: c.rect, promptText: c.promptText,
      tagName: c.tagName, src: c.src, frameId: c.frameId, frameUrl: c.frameUrl, frameDepth: c.frameDepth
    })),
    cursorPoints:      allCursorPoints,
    cursorPointCount:  allCursorPoints.length,
    exportTrigger:     trigger
  };
}

async function saveSession(trigger) {
  if (!isTopFrame) return false;

  stopRecording(); // halt cursor tracking before assembling the snapshot

  // Guard: skip save if no images were captured (session has no research value).
  let capturedImageCount = 0;
  try {
    const imgResponse = await browser.runtime.sendMessage({ action: "get-captured-images" });
    capturedImageCount = (imgResponse.images || []).length;
  } catch (e) {}

  if (capturedImageCount === 0) {
    console.log("[DIARY] Skipping save — no images captured");
    return false;
  }

  // Fetch cursor and element data aggregated across all frames by background.js.
  // Falls back to this frame's local data if the message fails.
  let aggregatedData = { cursorPoints: cursorPoints, captchaElements: [] };
  try {
    aggregatedData = await browser.runtime.sendMessage({ action: "get-aggregated-data" });
  } catch (e) {}

  const resolvedCaptchaElements = aggregatedData.captchaElements || captchaElements.map(c => ({
    selector: c.selector, rect: c.rect, promptText: null,
    tagName: c.tagName, src: c.src, frameId: c.frameId, frameUrl: c.frameUrl, frameDepth: c.frameDepth
  }));

  const sessionData = {
    ...buildSessionData(trigger),
    cursorPoints:    aggregatedData.cursorPoints || cursorPoints,
    cursorPointCount: (aggregatedData.cursorPoints || cursorPoints).length,
    captchaElements: resolvedCaptchaElements
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
// A fixed red pill in the top-right corner shows that recording is active.
// The "End" button triggers a manual save + reset without waiting for the
// CAPTCHA to disappear from the DOM.

let indicatorEl = null;

function showRecordingIndicator() {
  if (!isTopFrame || indicatorEl) return;
  indicatorEl = document.createElement("div");
  indicatorEl.id = "captcha-diary-indicator";
  const { label: browserLabel, platform, userAgent } = getBrowserInfo();
  indicatorEl.innerHTML = `
    <style>
      #captcha-diary-indicator {
        position: fixed; top: 10px; right: 10px; z-index: 999999;
        background: rgba(220, 38, 38, 0.95); color: white;
        padding: 8px 14px; border-radius: 6px;
        font-family: system-ui, sans-serif; font-size: 12px;
        display: flex; align-items: center; gap: 10px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        pointer-events: auto; cursor: move; user-select: none;
      }
      #captcha-diary-indicator .dot {
        width: 8px; height: 8px; background: white; border-radius: 50%;
        animation: diary-blink 1s infinite;
      }
      @keyframes diary-blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
      #captcha-diary-indicator .info { font-size: 10px; opacity: 0.8; }
      #captcha-diary-ua {
        font-size: 10px; opacity: 0.85;
        background: rgba(255,255,255,0.15); border-radius: 3px;
        padding: 1px 6px; cursor: default;
      }
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
    <span id="captcha-diary-ua" title="${userAgent}">${browserLabel}${platform ? " · " + platform : ""}</span>
    <button id="captcha-diary-end-btn">End</button>
  `;
  document.body.appendChild(indicatorEl);

  // Restore saved position from previous drag within this session.
  const savedPos = (() => {
    try { return JSON.parse(sessionStorage.getItem("captcha-diary-pos")); } catch (e) { return null; }
  })();
  if (savedPos) {
    indicatorEl.style.top   = savedPos.top  + "px";
    indicatorEl.style.left  = savedPos.left + "px";
    indicatorEl.style.right = "auto";
  }

  // Drag logic: mousedown on the badge (but not on the End button) begins a drag.
  let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

  indicatorEl.addEventListener("mousedown", (e) => {
    if (e.target.id === "captcha-diary-end-btn") return;
    e.preventDefault();
    isDragging = true;
    const r = indicatorEl.getBoundingClientRect();
    dragOffsetX = e.clientX - r.left;
    dragOffsetY = e.clientY - r.top;
    // Convert from right-anchored to left-anchored so we can freely reposition.
    indicatorEl.style.left  = r.left + "px";
    indicatorEl.style.right = "auto";
    indicatorEl.style.top   = r.top  + "px";
  });

  const onDragMove = (e) => {
    if (!isDragging || !indicatorEl) return;
    const newLeft = Math.max(0, Math.min(window.innerWidth  - indicatorEl.offsetWidth,  e.clientX - dragOffsetX));
    const newTop  = Math.max(0, Math.min(window.innerHeight - indicatorEl.offsetHeight, e.clientY - dragOffsetY));
    indicatorEl.style.left = newLeft + "px";
    indicatorEl.style.top  = newTop  + "px";
  };

  const onDragEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    if (indicatorEl) {
      const r = indicatorEl.getBoundingClientRect();
      try { sessionStorage.setItem("captcha-diary-pos", JSON.stringify({ top: r.top, left: r.left })); } catch (e) {}
    }
  };

  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup",   onDragEnd);

  // Clean up drag listeners when the indicator is removed.
  indicatorEl._removeDragListeners = () => {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup",   onDragEnd);
  };

  const endBtn = document.getElementById("captcha-diary-end-btn");
  if (endBtn) {
    endBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      saveSession("manual").then(() => resetRecording());
    });
  }
}

function hideRecordingIndicator() {
  if (indicatorEl) {
    if (indicatorEl._removeDragListeners) indicatorEl._removeDragListeners();
    indicatorEl.remove();
    indicatorEl = null;
  }
}

// ============================================
// CAPTCHA Element Outlines
// ============================================
// When elements are detected, inject fixed-position overlay divs that trace each
// element's bounding box with a 1px red border. Overlays are non-interactive
// (pointer-events: none) so they don't interfere with user interaction.
// They are keyed with the captcha-diary- prefix so detectCaptchaElements() skips them.

let outlineEls = [];

function clearCaptchaOutlines() {
  for (const el of outlineEls) el.remove();
  outlineEls = [];
}

// Full redraw: called only when captchaElements itself changes (detection events).
function updateCaptchaOutlines() {
  if (!isTopFrame) return;
  clearCaptchaOutlines();
  for (const c of captchaElements) {
    const r = (c.element && document.contains(c.element))
      ? c.element.getBoundingClientRect()
      : c.rect;
    if (r.width === 0 && r.height === 0) continue;
    const div = document.createElement("div");
    div.className = "captcha-diary-outline";
    div.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.top}px;` +
      `width:${r.width}px;height:${r.height}px;` +
      `border:1px solid red;pointer-events:none;z-index:999998;box-sizing:border-box;`;
    document.body.appendChild(div);
    outlineEls.push(div);
  }
}

// Lightweight reposition: only mutates style.left/top, no DOM creation or deletion.
// Called on scroll/resize — much cheaper than a full redraw.
function _repositionOutlines() {
  if (!isTopFrame || outlineEls.length === 0) return;
  let i = 0;
  for (const c of captchaElements) {
    const div = outlineEls[i++];
    if (!div) break;
    if (c.element && document.contains(c.element)) {
      const r = c.element.getBoundingClientRect();
      div.style.left = r.left + "px";
      div.style.top  = r.top  + "px";
    }
  }
}

let _outlineRafId = null;
function _scheduleReposition() {
  if (!isRecording || !isTopFrame || outlineEls.length === 0) return;
  if (_outlineRafId !== null) cancelAnimationFrame(_outlineRafId);
  _outlineRafId = requestAnimationFrame(() => {
    _outlineRafId = null;
    _repositionOutlines();
  });
}
window.addEventListener("scroll", _scheduleReposition, { passive: true });
window.addEventListener("resize", _scheduleReposition, { passive: true });

// ============================================
// Keyboard Shortcut (top frame only)
// ============================================
// Ctrl+Shift+E — manual save, same effect as clicking "End" in the indicator.

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
// Messages arrive from background.js in response to tab/window events.

browser.runtime.onMessage.addListener((message) => {

  // Background has registered this tab as watched — begin monitoring.
  if (message.action === "you-are-watched") {
    startMonitoring();
  }

  // User granted consent for this browser window — begin monitoring all tabs in it.
  if (message.action === "consent-granted") {
    startMonitoring();
  }

  // Background reports a new network-captured image count.
  // Used for round counting: ≥3 new images arriving together suggests a new challenge round.
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
// Exposed on window for debugging in the browser console.
// window.captchaDiary.getData() shows current recording state at a glance.

window.captchaDiary = {
  save:         saveSession,
  getData: () => ({
    isMonitoring,
    isRecording,
    isTopFrame,
    frameId,
    frameDepth,
    cursorPoints:    cursorPoints.length,
    captchaElements: captchaElements.map(c => c.selector),
    duration:        isRecording ? Date.now() - recordingStartTime : 0,
    rounds:          roundCount
  }),
  getFrameInfo: () => ({ frameId, frameUrl, frameDepth, isTopFrame })
};

// ============================================
// Startup
// ============================================
// The content script is injected at document_start on every page and frame.
// It starts inert and waits for consent confirmation before doing anything.
// Two paths to activation:
//   1. Background sends "you-are-watched" when the user activates a tab.
//   2. Content script checks consent itself on load (covers page reloads
//      within an already-consented window where the message may not arrive).

if (isTopFrame) {
  console.log("[DIARY] Content script loaded (TOP FRAME)");
  console.log(`[DIARY] Export config: navigation=${EXPORT_CONFIG.onNavigation}, interval=${EXPORT_CONFIG.intervalEnabled ? EXPORT_CONFIG.intervalMs/1000 + "s" : "off"}`);
  setupNavigationExport(); // attach beforeunload + visibilitychange save hooks
} else {
  console.log(`[DIARY] Content script loaded (child frame, depth=${frameDepth})`);
}

(async function initialize() {
  try {
    // Fast path: already watched (tab was navigated within an active session).
    const watchedResp = await browser.runtime.sendMessage({ action: "check-watched" });
    if (watchedResp && watchedResp.watched) {
      startMonitoring();
      return;
    }
    // Slow path: window consented but "you-are-watched" not yet received
    // (can happen on page reload within an already-consented window).
    const consentResp = await browser.runtime.sendMessage({ action: "check-consent" });
    if (consentResp && consentResp.consented) {
      startMonitoring();
    }
    // else: inert — wait for "you-are-watched" or "consent-granted" from background.
  } catch (e) {
    // Extension context unavailable (e.g. browser privileged pages like about:blank).
  }
})();