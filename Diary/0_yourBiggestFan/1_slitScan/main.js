// main.js - Slit-scan cursor tracker
// Captures 32x32 pixel regions at cursor position, extracts vertical strips, builds slit-scan

let isArmed = false;
let isRecording = false;
let recordingStartTime = 0;

// Slit-scan data
let slitScanCanvas = null;
let slitScanCtx = null;
let slitPosition = 0;  // Current x position in the slit-scan canvas
let lastCaptureTime = 0;

const CAPTURE_INTERVAL = 20;   // Capture every 50ms
const CAPTURE_SIZE = 32;       // 32x32 pixel capture region
const SLIT_WIDTH = 1;          // 1px vertical strip from each capture
const SLIT_HEIGHT = CAPTURE_SIZE;
const MAX_SLITS = 4000;        // Max width of slit-scan (4000px)

const STORAGE_KEY = "slitScanData";

// Convert Date to local time string: yymmddhhmmss
function formatTimestamp(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yy}${mm}${dd}${hh}${min}${ss}`;
}

// Initialize the slit-scan canvas (hidden, used for building the image)
function initSlitScanCanvas() {
  slitScanCanvas = document.createElement("canvas");
  slitScanCanvas.width = MAX_SLITS;
  slitScanCanvas.height = SLIT_HEIGHT;
  slitScanCtx = slitScanCanvas.getContext("2d");
  slitScanCtx.fillStyle = "black";
  slitScanCtx.fillRect(0, 0, MAX_SLITS, SLIT_HEIGHT);
  slitPosition = 0;
}

// Capture the region around cursor via background script
async function captureSlitAtCursor(x, y) {
  try {
    // Request capture from background script
    const response = await browser.runtime.sendMessage({
      action: "capture",
      x: x,
      y: y,
      devicePixelRatio: window.devicePixelRatio
    });

    if (!response.success) {
      console.warn("Capture failed:", response.error);
      return;
    }

    // Load the strip image and draw to slit-scan canvas
    const img = new Image();
    img.onload = () => {
      if (slitPosition < MAX_SLITS) {
        slitScanCtx.drawImage(img, slitPosition, 0);
        slitPosition += SLIT_WIDTH;
        updateLiveView();  // Update after drawing
      }
    };
    img.src = response.stripDataUrl;

  } catch (err) {
    console.warn("Capture failed:", err);
  }
}

// Mouse move handler with throttled capture
async function handleMouseMove(event) {
  const now = Date.now();

  // Throttle captures
  if (now - lastCaptureTime < CAPTURE_INTERVAL) return;
  lastCaptureTime = now;

  await captureSlitAtCursor(event.clientX, event.clientY);
}

// Start recording
function startRecording() {
  isRecording = true;
  recordingStartTime = Date.now();
  lastCaptureTime = 0;
  initSlitScanCanvas();
  createLiveView();
  document.addEventListener("mousemove", handleMouseMove);
  console.log("Slit-scan recording started... (spacebar=stop, E=export, C=clear)");
}

// Stop recording
function stopRecording() {
  isRecording = false;
  document.removeEventListener("mousemove", handleMouseMove);
  removeLiveView();

  const duration = Date.now() - recordingStartTime;
  console.log(`Recording stopped. ${slitPosition} slits captured over ${(duration / 1000).toFixed(1)}s`);

  // Save metadata
  saveRecordingMetadata(duration);
}

// Save recording metadata to sessionStorage
function saveRecordingMetadata(duration) {
  const recordings = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
  recordings.push({
    slits: slitPosition,
    duration: duration,
    recordedAt: formatTimestamp(),
    url: window.location.href
  });
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(recordings));
}

// Export slit-scan as PNG
function exportSlitScan() {
  if (!slitScanCanvas || slitPosition === 0) {
    console.log("No slit-scan data to export.");
    return;
  }

  // Create a trimmed canvas (only the captured portion)
  const trimmedCanvas = document.createElement("canvas");
  trimmedCanvas.width = slitPosition;
  trimmedCanvas.height = SLIT_HEIGHT;
  const trimmedCtx = trimmedCanvas.getContext("2d");
  trimmedCtx.drawImage(slitScanCanvas, 0, 0);

  // Download
  const link = document.createElement("a");
  link.download = `slitscan-${formatTimestamp()}.png`;
  link.href = trimmedCanvas.toDataURL("image/png");
  link.click();

  console.log(`Exported slit-scan: ${slitPosition}x${SLIT_HEIGHT}px`);
}

// Clear stored data
function clearStoredData() {
  sessionStorage.removeItem(STORAGE_KEY);
  if (slitScanCanvas) {
    slitScanCtx.fillStyle = "black";
    slitScanCtx.fillRect(0, 0, MAX_SLITS, SLIT_HEIGHT);
    slitPosition = 0;
  }
  console.log("Slit-scan data cleared.");
}

// Live view showing slit-scan as it's being built
let liveViewElement = null;
let liveViewCanvas = null;
let liveViewCtx = null;

function createLiveView() {
  liveViewElement = document.createElement("div");
  liveViewElement.id = "slitscan-live";
  liveViewElement.style.cssText = `
    position: fixed;
    bottom: 10px;
    left: 10px;
    background: rgba(0, 0, 0, 0.9);
    border: 2px solid white;
    padding: 4px;
    z-index: 999999;
  `;

  // Canvas shows the growing slit-scan (2x height for visibility)
  liveViewCanvas = document.createElement("canvas");
  liveViewCanvas.width = 600;  // Max display width
  liveViewCanvas.height = 64;  // 32px * 2
  liveViewCanvas.style.cssText = "image-rendering: pixelated; display: block;";
  liveViewCtx = liveViewCanvas.getContext("2d");
  liveViewCtx.imageSmoothingEnabled = false;
  liveViewCtx.fillStyle = "black";
  liveViewCtx.fillRect(0, 0, 600, 64);
  liveViewElement.appendChild(liveViewCanvas);

  document.body.appendChild(liveViewElement);
}

function updateLiveView() {
  if (!liveViewCanvas || !liveViewCtx || !slitScanCanvas) return;

  // Clear and redraw the current slit-scan progress
  liveViewCtx.fillStyle = "black";
  liveViewCtx.fillRect(0, 0, 600, 64);

  // Draw the slit-scan canvas scaled to fit (scrolls left when full)
  const displayWidth = Math.min(slitPosition, 600);
  const srcX = Math.max(0, slitPosition - 600);
  liveViewCtx.drawImage(
    slitScanCanvas,
    srcX, 0, displayWidth, SLIT_HEIGHT,
    0, 0, displayWidth, 64
  );
}

function removeLiveView() {
  if (liveViewElement && liveViewElement.parentNode) {
    liveViewElement.parentNode.removeChild(liveViewElement);
  }
  liveViewElement = null;
  liveViewCanvas = null;
  liveViewCtx = null;
}

// Show live preview of the slit-scan
let previewElement = null;

function showPreview() {
  if (!slitScanCanvas) return;

  if (!previewElement) {
    previewElement = document.createElement("div");
    previewElement.id = "slitscan-preview";
    previewElement.style.cssText = `
      position: fixed;
      bottom: 10px;
      left: 10px;
      background: black;
      border: 2px solid white;
      padding: 4px;
      z-index: 999999;
      max-width: 80vw;
      overflow-x: auto;
    `;
    document.body.appendChild(previewElement);
  }

  // Create a scaled preview
  const previewCanvas = document.createElement("canvas");
  const displayWidth = Math.min(slitPosition, 600);
  previewCanvas.width = displayWidth;
  previewCanvas.height = SLIT_HEIGHT * 2;  // 2x height for visibility
  const ctx = previewCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(slitScanCanvas, 0, 0, slitPosition, SLIT_HEIGHT, 0, 0, displayWidth, SLIT_HEIGHT * 2);

  previewElement.innerHTML = "";
  previewElement.appendChild(previewCanvas);
}

function hidePreview() {
  if (previewElement && previewElement.parentNode) {
    previewElement.parentNode.removeChild(previewElement);
    previewElement = null;
  }
}

// Handle keyboard input
function handleKeyDown(event) {
  if (!isArmed) return;

  if (event.code === "Space") {
    event.preventDefault();
    if (isRecording) {
      stopRecording();
      showPreview();
    } else {
      hidePreview();
      startRecording();
    }
  } else if (event.code === "KeyE") {
    event.preventDefault();
    exportSlitScan();
  } else if (event.code === "KeyC") {
    event.preventDefault();
    clearStoredData();
    hidePreview();
  } else if (event.code === "KeyP") {
    event.preventDefault();
    if (previewElement) {
      hidePreview();
    } else {
      showPreview();
    }
  }
}

// Arm/disarm the extension
function toggleArmed() {
  isArmed = !isArmed;

  if (isArmed) {
    document.addEventListener("keydown", handleKeyDown);
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    console.log(`Armed! ${stored.length} recording(s) in session.`);
    console.log("Controls: SPACE=record, E=export PNG, P=preview, C=clear");
  } else {
    document.removeEventListener("keydown", handleKeyDown);
    if (isRecording) {
      stopRecording();
    }
    hidePreview();
    console.log("Disarmed.");
  }
}

// Listen for messages from the background script
browser.runtime.onMessage.addListener((message) => {
  if (message.action === "arm") {
    toggleArmed();
  }
});

// Expose functions to console
window.slitScan = {
  export: exportSlitScan,
  clear: clearStoredData,
  preview: showPreview,
  hidePreview: hidePreview
};
