// background.js - Handles toolbar button clicks and screen capture

const CAPTURE_SIZE = 32;

// Handle toolbar button click
browser.browserAction.onClicked.addListener((tab) => {
  browser.tabs.sendMessage(tab.id, { action: "arm" });
});

// Handle capture requests from content script
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "capture") {
    captureAndCrop(message.x, message.y, message.devicePixelRatio)
      .then(stripDataUrl => sendResponse({ success: true, stripDataUrl }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }
});

// Capture visible tab and extract 1px vertical strip at cursor position
async function captureAndCrop(x, y, dpr = 1) {
  // Capture the visible tab as data URL
  const dataUrl = await browser.tabs.captureVisibleTab(null, {
    format: "png"
  });

  // Load into an image to extract pixels
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Account for device pixel ratio
      const scale = dpr || 1;
      const scaledX = Math.floor(x * scale);
      const scaledY = Math.floor(y * scale);
      const scaledSize = Math.floor(CAPTURE_SIZE * scale);

      // Create canvas for the captured region
      const canvas = document.createElement("canvas");
      canvas.width = scaledSize;
      canvas.height = scaledSize;
      const ctx = canvas.getContext("2d");

      // Calculate source region (centered on cursor)
      const srcX = Math.max(0, scaledX - scaledSize / 2);
      const srcY = Math.max(0, scaledY - scaledSize / 2);

      // Draw the region
      ctx.drawImage(img, srcX, srcY, scaledSize, scaledSize, 0, 0, scaledSize, scaledSize);

      // Extract center 1px vertical strip (scaled back to 32px height)
      const stripCanvas = document.createElement("canvas");
      stripCanvas.width = 1;
      stripCanvas.height = CAPTURE_SIZE;
      const stripCtx = stripCanvas.getContext("2d");

      // Draw scaled down to 1x32
      const centerX = Math.floor(scaledSize / 2);
      stripCtx.drawImage(canvas, centerX, 0, 1, scaledSize, 0, 0, 1, CAPTURE_SIZE);

      // Return as data URL (avoids cross-context security issues)
      resolve(stripCanvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("Failed to load capture"));
    img.src = dataUrl;
  });
}