// main.js - Content script that runs on web pages
// This script has access to the page's DOM and can track mouse events

let isArmed = false;     // Plugin clicked, waiting for spacebar
let isRecording = false;
let cursorPath = [];     // Current recording session
let svg = null;
let segments = [];       // Individual line segments for fading effect
let recordingStartTime = 0;  // Epoch ms when recording started

const TRAIL_DURATION = 3000;  // How long before a segment fully fades (ms)
const FADE_INTERVAL = 50;     // How often to update opacity (ms)
const STORAGE_KEY = "cursorTracePaths";
let fadeTimer = null;

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

// Load existing paths from sessionStorage
function loadStoredPaths() {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  return stored ? JSON.parse(stored) : [];
}

// Save paths to sessionStorage
function savePathToStorage(path) {
  const allPaths = loadStoredPaths();
  const duration = path.length > 0 ? path[path.length - 1].t : 0;
  allPaths.push({
    points: path,
    duration: duration,  // Total duration in ms
    recordedAt: formatTimestamp(),
    url: window.location.href
  });
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(allPaths));
  console.log(`Saved recording #${allPaths.length} (${path.length} points, ${(duration / 1000).toFixed(1)}s)`);
}

// Generate SVG string from all stored paths
function generateSVG() {
  const allPaths = loadStoredPaths();
  if (allPaths.length === 0) {
    console.log("No paths stored yet.");
    return null;
  }

  // Find bounding box
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  allPaths.forEach(recording => {
    recording.points.forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    });
  });

  const padding = 20;
  const width = maxX - minX + padding * 2;
  const height = maxY - minY + padding * 2;

  let svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="white"/>
`;

  allPaths.forEach((recording, idx) => {
    if (recording.points.length < 2) return;

    let d = `M ${recording.points[0].x - minX + padding} ${recording.points[0].y - minY + padding}`;
    for (let i = 1; i < recording.points.length; i++) {
      d += ` L ${recording.points[i].x - minX + padding} ${recording.points[i].y - minY + padding}`;
    }

    svgContent += `  <path d="${d}" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" data-recording="${idx + 1}"/>\n`;
  });

  svgContent += `</svg>`;
  return svgContent;
}

// Download SVG file
function downloadSVG() {
  const svgContent = generateSVG();
  if (!svgContent) return;

  const blob = new Blob([svgContent], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `cursor-trace-${formatTimestamp()}.svg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log("SVG downloaded!");
}

// Clear all stored paths
function clearStoredPaths() {
  sessionStorage.removeItem(STORAGE_KEY);
  console.log("All stored paths cleared.");
}

// Create the SVG overlay (like tracing paper on top of the page)
function createOverlay() {
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", "cursor-trace-overlay");
  svg.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    mix-blend-mode: difference;
  `;

  document.body.appendChild(svg);
}

// Create a line segment between two points
function createSegment(x1, y1, x2, y2) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute("stroke", "white");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  return line;
}

// Update all segment opacities based on age
function updateFade() {
  const now = Date.now();

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    const age = now - seg.timestamp;
    const opacity = Math.max(0, 1 - (age / TRAIL_DURATION));

    if (opacity <= 0) {
      // Remove fully faded segment from display only
      if (seg.element.parentNode) {
        seg.element.parentNode.removeChild(seg.element);
      }
      segments.splice(i, 1);
    } else {
      seg.element.setAttribute("opacity", opacity);
    }
  }
}

// Remove the SVG overlay
function removeOverlay() {
  if (fadeTimer) {
    clearInterval(fadeTimer);
    fadeTimer = null;
  }
  if (svg && svg.parentNode) {
    svg.parentNode.removeChild(svg);
  }
  svg = null;
  segments = [];
}

// Mouse move handler - captures position and updates visualization
function handleMouseMove(event) {
  const point = {
    x: event.clientX,
    y: event.clientY,
    t: Date.now() - recordingStartTime  // Relative time in ms
  };

  // Draw line segment from previous point
  if (cursorPath.length > 0 && svg) {
    const prev = cursorPath[cursorPath.length - 1];
    const line = createSegment(prev.x, prev.y, point.x, point.y);
    svg.appendChild(line);
    segments.push({
      element: line,
      timestamp: Date.now()
    });
  }

  cursorPath.push(point);
}

// Start recording
function startRecording() {
  isRecording = true;
  cursorPath = [];
  segments = [];
  recordingStartTime = Date.now();
  createOverlay();
  document.addEventListener("mousemove", handleMouseMove);

  // Start the fade timer
  fadeTimer = setInterval(updateFade, FADE_INTERVAL);

  console.log("Recording started... (spacebar=stop, E=export, C=clear)");
}

// Stop recording
function stopRecording() {
  isRecording = false;
  document.removeEventListener("mousemove", handleMouseMove);

  // Save to sessionStorage before clearing visual
  if (cursorPath.length > 0) {
    savePathToStorage(cursorPath);
  }

  console.log(`Captured ${cursorPath.length} points.`);

  // Let remaining trail fade out naturally, then remove
  setTimeout(() => {
    if (fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
    if (svg) {
      svg.style.transition = "opacity 1s";
      svg.style.opacity = "0";
      setTimeout(removeOverlay, 1000);
    }
  }, TRAIL_DURATION);
}

// Handle keyboard input
function handleKeyDown(event) {
  if (!isArmed) return;

  if (event.code === "Space") {
    event.preventDefault();
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  } else if (event.code === "KeyE") {
    event.preventDefault();
    downloadSVG();
  } else if (event.code === "KeyC") {
    event.preventDefault();
    clearStoredPaths();
  }
}

// Arm/disarm the extension (toggle spacebar listening)
function toggleArmed() {
  isArmed = !isArmed;

  if (isArmed) {
    document.addEventListener("keydown", handleKeyDown);
    const stored = loadStoredPaths();
    console.log(`Armed! ${stored.length} recording(s) in session.`);
    console.log("Controls: SPACE=record, E=export SVG, C=clear");
  } else {
    document.removeEventListener("keydown", handleKeyDown);
    if (isRecording) {
      stopRecording();
    }
    console.log("Disarmed.");
  }
}

// Listen for messages from the background script
browser.runtime.onMessage.addListener((message) => {
  if (message.action === "arm") {
    toggleArmed();
  }
});

// Expose functions to console for manual use
window.cursorTrace = {
  export: downloadSVG,
  clear: clearStoredPaths,
  getPaths: loadStoredPaths,
  getSVG: generateSVG
};
