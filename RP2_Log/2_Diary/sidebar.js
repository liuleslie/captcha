// sidebar.js - Full archive browser for CAPTCHA Diary
// Persistent across tab switches (sidebar_action panel).
// Communicates with background via port (real-time) and sendMessage (queries).

// ============================================
// Port (real-time updates from background)
// ============================================

const port = browser.runtime.connect({ name: "sidebar" });
let requestCounter = 0;
const pendingRequests = {};

port.onMessage.addListener((message) => {
  // Resolve pending port-based requests
  if (message.requestId && pendingRequests[message.requestId]) {
    pendingRequests[message.requestId](message);
    delete pendingRequests[message.requestId];
    return;
  }

  if (message.action === "session-saved") {
    prependSessionCard(message.session);
    updateStats();
  }
  if (message.action === "archive-stats-updated") {
    setStatsBar(message.totalSessions, message.totalImages);
  }
  if (message.action === "session-deleted") {
    const card = document.querySelector(`[data-session-id="${message.sessionId}"]`);
    if (card) revokeBlobsAndRemove(card);
    updateStats();
  }
});

function portRequest(action, params = {}) {
  return new Promise((resolve) => {
    const requestId = ++requestCounter;
    pendingRequests[requestId] = resolve;
    port.postMessage({ action, requestId, ...params });
  });
}

// ============================================
// State
// ============================================

let currentOffset = 0;
const PAGE_SIZE = 20;
let currentFilter = {};
let totalSessions = 0;
let isLoading = false;
let currentDetailSessionId = null;
const detailBlobUrls = [];
const cardBlobUrls = new Map(); // sessionId → [blobUrl, ...]

// ============================================
// Utilities
// ============================================

function formatTimeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(isoString).toLocaleDateString();
}

function formatDate(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleString();
}

function formatDuration(ms) {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function providerLabel(provider) {
  const map = {
    recaptcha: "reCAPTCHA", hcaptcha: "hCaptcha", cloudflare: "Turnstile",
    geetest: "GeeTest", arkose: "Arkose", datadome: "DataDome",
    perimeterx: "PerimeterX", slider: "Slider", unknown: "CAPTCHA"
  };
  return map[provider] || "CAPTCHA";
}

function revokeBlobsAndRemove(card) {
  const sessionId = card.dataset.sessionId;
  const urls = cardBlobUrls.get(sessionId) || [];
  for (const url of urls) URL.revokeObjectURL(url);
  cardBlobUrls.delete(sessionId);
  card.remove();
}

// ============================================
// Stats Bar
// ============================================

function setStatsBar(sessions, images) {
  totalSessions = sessions;
  const bar = document.getElementById("stats-bar");
  if (sessions === 0) {
    bar.textContent = "No sessions recorded yet";
    document.getElementById("empty-state").style.display = "block";
  } else {
    bar.textContent = `${sessions} session${sessions !== 1 ? "s" : ""} · ${images} image${images !== 1 ? "s" : ""}`;
    document.getElementById("empty-state").style.display = "none";
  }
}

async function updateStats() {
  try {
    const resp = await browser.runtime.sendMessage({ action: "get-archive-stats" });
    if (resp && resp.stats) setStatsBar(resp.stats.totalSessions, resp.stats.totalImages);
  } catch (e) {}
}

// ============================================
// Filter dropdowns
// ============================================

async function populateFilters() {
  try {
    const resp = await portRequest("get-filter-options");
    const providerSelect = document.getElementById("filter-provider");
    for (const p of (resp.providers || [])) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = providerLabel(p);
      providerSelect.appendChild(opt);
    }
  } catch (e) {}
}

// ============================================
// Session Card Rendering
// ============================================

function buildCardElement(session) {
  const card = document.createElement("div");
  card.className = "session-card";
  card.dataset.sessionId = session.sessionId;

  card.innerHTML = `
    <div class="card-header">
      <div class="card-header-left">
        <input type="checkbox" class="card-select" data-session-id="${session.sessionId}">
        <span class="card-hostname" title="${session.sourceUrl}">${session.hostname || "—"}</span>
      </div>
      <span class="card-time">${formatTimeAgo(session.savedAt)}</span>
    </div>
    <div class="card-badges">
      <span class="badge provider">${providerLabel(session.provider)}</span>
      <span class="badge">${session.imageCount} img</span>
      <span class="badge">${session.rounds} round${session.rounds !== 1 ? "s" : ""}</span>
      <span class="badge">${formatDuration(session.duration)}</span>
    </div>
    <div class="card-thumbs" id="thumbs-${session.sessionId}"></div>
    <div class="card-meta">${formatDate(session.savedAt)}</div>
  `;

  // Stop checkbox clicks from opening detail
  card.querySelector(".card-select").addEventListener("click", (e) => {
    e.stopPropagation();
    updateExportSelectedVisibility();
  });

  card.addEventListener("click", (e) => {
    if (e.target.classList.contains("card-select")) return;
    openDetail(session.sessionId);
  });

  return card;
}

async function loadThumbnailsForCard(session) {
  const thumbsContainer = document.getElementById(`thumbs-${session.sessionId}`);
  if (!thumbsContainer) return;

  const blobUrls = [];
  const maxThumbs = Math.min(session.imageCount, 5);

  for (let i = 0; i < maxThumbs; i++) {
    const imageId = `${session.sessionId}-img-${String(i).padStart(3, "0")}`;
    try {
      const resp = await browser.runtime.sendMessage({ action: "get-image", imageId });
      if (resp && resp.image && resp.image.blob) {
        const url = URL.createObjectURL(resp.image.blob);
        blobUrls.push(url);
        const img = document.createElement("img");
        img.className = "card-thumb";
        img.src = url;
        img.alt = "";
        thumbsContainer.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "card-thumb-placeholder";
        thumbsContainer.appendChild(ph);
      }
    } catch (e) {
      const ph = document.createElement("div");
      ph.className = "card-thumb-placeholder";
      thumbsContainer.appendChild(ph);
    }
  }

  // Store blob URLs for cleanup
  cardBlobUrls.set(session.sessionId, blobUrls);
}

function prependSessionCard(session) {
  const list = document.getElementById("session-list");
  const emptyState = document.getElementById("empty-state");
  emptyState.style.display = "none";

  const card = buildCardElement(session);
  list.insertBefore(card, list.firstChild);

  // Load thumbnails asynchronously
  loadThumbnailsForCard(session);

  currentOffset++; // Keep offset accurate
}

// ============================================
// Load Sessions (paginated)
// ============================================

async function loadPage(offset, append = false) {
  if (isLoading) return;
  isLoading = true;

  const filter = {};
  const hostnameFilter = document.getElementById("filter-hostname").value.trim();
  const providerFilter = document.getElementById("filter-provider").value;
  if (hostnameFilter) filter.hostname = hostnameFilter;
  if (providerFilter) filter.provider = providerFilter;
  currentFilter = filter;

  try {
    const resp = await portRequest("get-sessions", { offset, limit: PAGE_SIZE, filter });
    const sessions = resp.sessions || [];

    if (!append) {
      // Clear existing cards (revoke blob URLs)
      const list = document.getElementById("session-list");
      const cards = list.querySelectorAll(".session-card");
      for (const card of cards) revokeBlobsAndRemove(card);
      currentOffset = 0;
    }

    for (const session of sessions) {
      const list = document.getElementById("session-list");
      const card = buildCardElement(session);
      list.appendChild(card);
      loadThumbnailsForCard(session); // async, non-blocking
    }

    currentOffset = offset + sessions.length;

    const loadMoreEl = document.getElementById("load-more");
    document.getElementById("load-more-btn");
    loadMoreEl.style.display = sessions.length === PAGE_SIZE ? "block" : "none";

    if (currentOffset === 0) {
      document.getElementById("empty-state").style.display = "block";
    }
  } catch (e) {
    console.error("[DIARY sidebar] loadPage failed:", e);
  }

  isLoading = false;
}

// ============================================
// Detail View
// ============================================

async function openDetail(sessionId) {
  currentDetailSessionId = sessionId;

  // Revoke any previous detail blob URLs
  for (const url of detailBlobUrls) URL.revokeObjectURL(url);
  detailBlobUrls.length = 0;

  const overlay = document.getElementById("detail-overlay");
  overlay.classList.remove("hidden");

  const body = document.getElementById("detail-body");
  body.innerHTML = "<p style='color:#9ca3af;padding:20px 0;text-align:center'>Loading…</p>";

  try {
    const resp = await browser.runtime.sendMessage({ action: "get-session-detail", sessionId });
    const session = resp.session;
    if (!session) { body.innerHTML = "<p style='color:#ef4444;padding:20px 0'>Session not found.</p>"; return; }

    document.getElementById("detail-title").textContent = session.hostname || "Session";

    let html = "";

    // Metadata section
    html += `<div class="detail-section">
      <div class="detail-section-title">Session Info</div>
      <div class="detail-meta-grid">
        <div class="detail-meta-row"><span>Provider</span><br>${providerLabel(session.provider)}</div>
        <div class="detail-meta-row"><span>Saved</span><br>${formatDate(session.savedAt)}</div>
        <div class="detail-meta-row"><span>Duration</span><br>${formatDuration(session.duration)}</div>
        <div class="detail-meta-row"><span>Rounds</span><br>${session.rounds}</div>
        <div class="detail-meta-row"><span>Images</span><br>${session.imageCount}</div>
        <div class="detail-meta-row"><span>Cursor pts</span><br>${session.cursorPointCount.toLocaleString()}</div>
        <div class="detail-meta-row"><span>Viewport</span><br>${session.viewport ? `${session.viewport.width}×${session.viewport.height}` : "—"}</div>
        <div class="detail-meta-row"><span>Trigger</span><br>${session.exportTrigger || "—"}</div>
      </div>
    </div>`;

    // URL
    html += `<div class="detail-section">
      <div class="detail-section-title">Source URL</div>
      <div style="font-size:11px;color:#6b7280;word-break:break-all">${session.sourceUrl || "—"}</div>
    </div>`;

    // CAPTCHA elements
    if (session.captchaElements && session.captchaElements.length > 0) {
      html += `<div class="detail-section">
        <div class="detail-section-title">Detected Elements (${session.captchaElements.length})</div>`;
      for (const el of session.captchaElements) {
        html += `<div style="font-size:11px;color:#374151;margin-bottom:4px;padding:4px 6px;background:#f9fafb;border-radius:3px;word-break:break-all">
          <code>${el.selector}</code>
          ${el.promptText ? `<br><span style="color:#6b7280">"${el.promptText}"</span>` : ""}
        </div>`;
      }
      html += `</div>`;
    }

    // Images grid (placeholder, will be populated after render)
    html += `<div class="detail-section">
      <div class="detail-section-title">Images (${session.imageCount})</div>
      <div class="detail-images-grid" id="detail-images-grid"></div>
    </div>`;

    // Notes
    html += `<div class="detail-section">
      <div class="detail-section-title">Notes</div>
      <textarea class="notes-textarea" id="detail-notes" placeholder="Add research notes about this session…">${session.notes || ""}</textarea>
      <button class="notes-save-btn" id="detail-notes-save">Save notes</button>
    </div>`;

    body.innerHTML = html;

    // Load images into grid
    const grid = document.getElementById("detail-images-grid");
    if (grid) {
      for (let i = 0; i < session.imageCount; i++) {
        const imageId = `${sessionId}-img-${String(i).padStart(3, "0")}`;
        try {
          const imgResp = await browser.runtime.sendMessage({ action: "get-image", imageId });
          if (imgResp && imgResp.image && imgResp.image.blob) {
            const url = URL.createObjectURL(imgResp.image.blob);
            detailBlobUrls.push(url);
            const img = document.createElement("img");
            img.className = "detail-img";
            img.src = url;
            img.alt = `Image ${i + 1}`;
            img.addEventListener("click", () => openLightbox(url));
            grid.appendChild(img);
          }
        } catch (e) {}
      }
    }

    // Notes save button
    const notesSaveBtn = document.getElementById("detail-notes-save");
    if (notesSaveBtn) {
      notesSaveBtn.addEventListener("click", async () => {
        const notes = document.getElementById("detail-notes").value;
        await browser.runtime.sendMessage({ action: "update-session-notes", sessionId, notes });
        notesSaveBtn.textContent = "Saved!";
        setTimeout(() => { notesSaveBtn.textContent = "Save notes"; }, 1500);
      });
    }

  } catch (e) {
    body.innerHTML = `<p style='color:#ef4444;padding:20px 0'>Error loading session: ${e.message}</p>`;
  }
}

function closeDetail() {
  document.getElementById("detail-overlay").classList.add("hidden");
  currentDetailSessionId = null;
  for (const url of detailBlobUrls) URL.revokeObjectURL(url);
  detailBlobUrls.length = 0;
}

// ============================================
// Lightbox
// ============================================

function openLightbox(url) {
  document.getElementById("lightbox-img").src = url;
  document.getElementById("lightbox").classList.remove("hidden");
}

document.getElementById("lightbox").addEventListener("click", () => {
  document.getElementById("lightbox").classList.add("hidden");
  document.getElementById("lightbox-img").src = "";
});

// ============================================
// Export
// ============================================

function getCheckedSessionIds() {
  const checkboxes = document.querySelectorAll(".card-select:checked");
  return Array.from(checkboxes).map(cb => cb.dataset.sessionId);
}

function updateExportSelectedVisibility() {
  const count = document.querySelectorAll(".card-select:checked").length;
  const show = count > 0 ? "inline-block" : "none";
  document.getElementById("export-selected-btn").style.display = show;
  const delBtn = document.getElementById("delete-selected-btn");
  delBtn.style.display = show;
  delBtn.textContent = count > 0 ? `Delete selected (${count})` : "Delete selected";
}

document.getElementById("export-all-btn").addEventListener("click", () => {
  browser.runtime.sendMessage({ action: "export-zip", sessionIds: [] }); // empty = all
});

document.getElementById("export-selected-btn").addEventListener("click", () => {
  const ids = getCheckedSessionIds();
  if (ids.length > 0) browser.runtime.sendMessage({ action: "export-zip", sessionIds: ids });
});

document.getElementById("delete-selected-btn").addEventListener("click", async () => {
  const ids = getCheckedSessionIds();
  if (ids.length === 0) return;
  if (!confirm(`Delete ${ids.length} session${ids.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
  for (const sessionId of ids) {
    await browser.runtime.sendMessage({ action: "delete-session", sessionId });
  }
  await loadPage(0, false);
  await updateStats();
});

document.getElementById("detail-export-btn").addEventListener("click", () => {
  if (currentDetailSessionId) {
    browser.runtime.sendMessage({ action: "export-zip", sessionIds: [currentDetailSessionId] });
  }
});

document.getElementById("detail-delete-btn").addEventListener("click", async () => {
  if (!currentDetailSessionId) return;
  if (!confirm("Delete this session? This cannot be undone.")) return;
  await browser.runtime.sendMessage({ action: "delete-session", sessionId: currentDetailSessionId });
  closeDetail();
});

// ============================================
// Filters
// ============================================

let filterDebounce = null;
document.getElementById("filter-hostname").addEventListener("input", () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => loadPage(0, false), 300);
});

document.getElementById("filter-provider").addEventListener("change", () => {
  loadPage(0, false);
});

// ============================================
// Navigation
// ============================================

document.getElementById("back-btn").addEventListener("click", closeDetail);

document.getElementById("load-more-btn").addEventListener("click", () => {
  loadPage(currentOffset, true);
});

// ============================================
// Init
// ============================================

async function init() {
  await updateStats();
  await populateFilters();
  await loadPage(0, false);
}

init();
