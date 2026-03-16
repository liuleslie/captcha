// sidebar.js - Full archive browser for CAPTCHA Diary
// Persistent across tab switches (sidebar_action panel).
// Communicates with background via port (real-time) and sendMessage (queries).

// ============================================
// Port (real-time updates from background)
// ============================================

let port;
let requestCounter = 0;
const pendingRequests = {};

function connectPort() {
  try {
    port = browser.runtime.connect({ name: "sidebar" });
    console.log("[DIARY sidebar] port connected");
  } catch (e) {
    // Background not yet ready (e.g. mid-restart) — retry shortly.
    console.log("[DIARY sidebar] port connect failed, retrying:", e.message);
    setTimeout(connectPort, 1000);
    return;
  }

  port.onMessage.addListener((message) => {
    if (message.requestId && pendingRequests[message.requestId]) {
      pendingRequests[message.requestId](message);
      delete pendingRequests[message.requestId];
      return;
    }
    console.log("[DIARY sidebar] port message received:", message.action, message);
    if (message.action === "recording-active") {
      showActiveRecordingCard(message.tabId, message.hostname);
    }
    if (message.action === "recording-ended") {
      removeActiveRecordingCard(message.tabId);
    }
    if (message.action === "session-saved") {
      if (message.session?.tabId != null) removeActiveRecordingCard(message.session.tabId);
      loadPage();
      updateStats();
    }
    if (message.action === "archive-stats-updated") {
      setStatsBar(message.totalSessions, message.totalImages);
    }
    if (message.action === "session-deleted") {
      const card = document.querySelector(`[data-session-id="${message.sessionId}"]`);
      if (card) {
        const group = card.closest(".session-group");
        revokeBlobsAndRemove(card);
        if (group && group.querySelectorAll(".session-card").length === 0) group.remove();
      }
      updateStats();
    }
  });

  port.onDisconnect.addListener(() => {
    // Background script restarted (e.g. extension reload during development).
    // Clear in-flight state, then reconnect and refresh the view.
    console.log("[DIARY sidebar] port disconnected — will reconnect");
    isLoading = false;
    pendingReload = false;
    for (const id of Object.keys(pendingRequests)) {
      delete pendingRequests[id];
    }
    // connectPort() is synchronous but background's onConnect fires async.
    // Delay loadPage() so background has time to register its port.onMessage
    // listener before we send the first portRequest.
    setTimeout(() => {
      connectPort();
      setTimeout(loadPage, 300);
    }, 500);
  });
}

connectPort();

function portRequest(action, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      delete pendingRequests[requestId];
      reject(new Error(`portRequest timeout: ${action}`));
    }, 8000);
    pendingRequests[requestId] = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    port.postMessage({ action, requestId, ...params });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================
// State
// ============================================

let currentOffset = 0;
const PAGE_SIZE = 20;
let currentFilter = {};

// Time filter preset
let currentTimeFilter = null; // null = all time

const TIME_FILTERS = [
  { id: "all",       label: "All time",   dateRange: null, timeFrom: null, timeTo: null },
  { id: "today",     label: "Today",      dateRange: () => { const d = new Date(); d.setHours(0,0,0,0); return { from: d.toISOString() }; } },
  { id: "week",      label: "This week",  dateRange: () => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - d.getDay()); return { from: d.toISOString() }; } },
  { id: "month",     label: "This month", dateRange: () => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(1); return { from: d.toISOString() }; } },
  { id: "morning",   label: "Mornings",   subLabel: "before 11am",  timeFrom: "00:00", timeTo: "10:59" },
  { id: "afternoon", label: "Afternoons", subLabel: "12pm – 4pm",   timeFrom: "12:00", timeTo: "15:59" },
  { id: "evening",   label: "Evenings",   subLabel: "5pm – 9pm",    timeFrom: "17:00", timeTo: "20:59" },
  { id: "night",     label: "Nights",     subLabel: "10pm – 12am",  timeFrom: "22:00", timeTo: "23:59" },
];
let totalSessions = 0;
let totalImages = 0;
let filteredSessionCount = null; // null = no active filter
let filteredImageCount = null;
let useAbsoluteTime = true;    // row timestamps: true = hh:mm, false = "x ago"
let groupTimeAbsolute = true;  // group header time ranges
let isLoading = false;
let pendingReload = false;
let currentDetailSessionId = null;
let currentView = "recordings"; // "recordings" | "images"
const detailBlobUrls = [];
const cardBlobUrls = new Map(); // sessionId → [blobUrl, ...]

// Lightbox navigation
let lightboxImages   = []; // full list: { url, isSceneCapture, sessionId?, lbIndex }
let lbList           = []; // active navigation subset (filtered to selection when active)
let lbIdx            = 0;
let isGlobalLightbox = false; // true when lightbox is showing cross-session images view

// Multi-select shift-click
let lastCheckedIndex = null;
// Persistent selection: survives view switches. Maps sessionId → imageCount.
const selectedSessionMap = new Map();


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

function formatTime(isoString) {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateHeader(dateKey) {
  const date = new Date(dateKey + "T12:00:00"); // noon to avoid timezone issues
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayKey = today.toISOString().slice(0, 10);
  const yesterdayKey = yesterday.toISOString().slice(0, 10);

  if (dateKey === todayKey) return "Today";
  if (dateKey === yesterdayKey) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function getTimeCluster(isoString) {
  const hour = new Date(isoString).getHours();
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
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
// Active Recording Card
// ============================================

function showActiveRecordingCard(tabId, hostname) {
  console.log("[DIARY sidebar] showActiveRecordingCard", tabId, hostname);
  removeActiveRecordingCard(tabId);
  const card = document.createElement("div");
  card.className = "active-recording-card";
  card.dataset.tabId = String(tabId);
  const dot = document.createElement("span");
  dot.className = "active-recording-dot";
  const label = document.createElement("span");
  label.className = "active-recording-label";
  label.textContent = `Recording on ${hostname || "—"}`;
  card.appendChild(dot);
  card.appendChild(label);
  const list = document.getElementById("session-list");
  list.insertBefore(card, list.firstChild);
}

function removeActiveRecordingCard(tabId) {
  document.querySelectorAll(`.active-recording-card[data-tab-id="${tabId}"]`).forEach(c => c.remove());
}

// ============================================
// Stats Bar
// ============================================

function updateStatsDisplay() {
  const selIds = getCheckedSessionIds();
  const selCount = selIds.length;
  const recEl = document.getElementById("stats-recordings");
  const imgEl = document.getElementById("stats-images");
  if (selCount > 0) {
    const selImages = [...selectedSessionMap.values()].reduce((sum, c) => sum + c, 0);
    // Use filtered counts as denominator when a filter is active
    const denomSessions = filteredSessionCount !== null ? filteredSessionCount : totalSessions;
    const denomImages   = filteredImageCount   !== null ? filteredImageCount   : totalImages;
    recEl.textContent = `${selCount}/${denomSessions}`;
    imgEl.textContent = `${selImages}/${denomImages}`;
  } else if (filteredSessionCount !== null) {
    recEl.textContent = `${filteredSessionCount}/${totalSessions}`;
    imgEl.textContent = `${filteredImageCount}/${totalImages}`;
  } else {
    recEl.textContent = totalSessions;
    imgEl.textContent = totalImages;
  }
}

function setStatsBar(sessions, images) {
  totalSessions = sessions;
  totalImages = images;
  document.getElementById("stats-recordings").textContent = sessions;
  document.getElementById("stats-images").textContent = images;

  if (sessions === 0) {
    document.getElementById("empty-state").style.display = "block";
  } else {
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
// Recent Filters
// ============================================

function recentFilterLabel(f) {
  const parts = [];
  if (f.hostname) parts.push(f.hostname);
  if (f.provider) parts.push(providerLabel(f.provider));
  if (f.hasImages === "yes") parts.push("with images");
  if (f.hasImages === "no")  parts.push("no images");
  if (f.timeFilterId && f.timeFilterId !== "all") {
    const tf = TIME_FILTERS.find(t => t.id === f.timeFilterId);
    if (tf) parts.push(tf.label);
  }
  return parts.join(" / ");
}

function isFilterNonEmpty(f) {
  return !!(f.hostname || f.provider || f.hasImages ||
    (f.timeFilterId && f.timeFilterId !== "all"));
}

function loadRecentFilters() {
  try { return JSON.parse(localStorage.getItem("diaryRecentFilters") || "[]"); }
  catch { return []; }
}

function saveRecentFilter(f) {
  if (!isFilterNonEmpty(f)) return;
  const label = recentFilterLabel(f);
  let recents = loadRecentFilters();
  recents = recents.filter(r => r.label !== label);
  recents.unshift({ label, filter: f });
  if (recents.length > 3) recents = recents.slice(0, 3);
  localStorage.setItem("diaryRecentFilters", JSON.stringify(recents));
  renderRecentFilters();
}

function renderRecentFilters() {
  const recents = loadRecentFilters();
  const row = document.getElementById("filter-recents");
  const container = document.getElementById("recents-chips");
  container.innerHTML = "";
  if (recents.length === 0) { row.style.display = "none"; return; }
  row.style.display = "flex";

  const clearBtn = document.getElementById("recents-clear-btn");
  if (clearBtn) {
    clearBtn.onclick = () => {
      localStorage.setItem("diaryRecentFilters", "[]");
      renderRecentFilters();
    };
  }

  for (const recent of recents) {
    const chip = document.createElement("span");
    chip.className = "recent-chip";
    const lbl = document.createElement("span");
    lbl.textContent = recent.label;
    const x = document.createElement("span");
    x.className = "recent-chip-x";
    x.textContent = "×";
    chip.appendChild(lbl);
    chip.appendChild(x);
    chip.addEventListener("click", (e) => {
      if (e.target === x) {
        const r = loadRecentFilters().filter(r => r.label !== recent.label);
        localStorage.setItem("diaryRecentFilters", JSON.stringify(r));
        renderRecentFilters();
        return;
      }
      applyRecentFilter(recent.filter);
    });
    container.appendChild(chip);
  }
}

function applyRecentFilter(f) {
  document.getElementById("filter-hostname").value = f.hostname || "";
  document.getElementById("filter-provider").value = f.provider || "";
  if (f.timeFilterId) {
    setTimeFilter(f.timeFilterId);
  }

  // Apply image filter via the header toggle state
  if (f.hasImages) {
    currentFilter.hasImages = f.hasImages;
    const idx = imageFilterStates.indexOf(f.hasImages);
    if (idx >= 0) {
      imageFilterIndex = idx;
      const btn = document.getElementById("toggle-images-btn");
      btn.dataset.tooltip = imageFilterLabels[idx];
      btn.classList.toggle("active", f.hasImages !== "");
    }
  }

  loadPage();
}

// ============================================
// Session Card Rendering
// ============================================

function buildCardElement(session) {
  // Compact row layout for Recordings View
  const row = document.createElement("div");
  row.className = "session-row";
  row.dataset.sessionId = session.sessionId;
  row.dataset.imageCount = session.imageCount;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "card-select";
  checkbox.dataset.sessionId = session.sessionId;
  checkbox.checked = selectedSessionMap.has(session.sessionId);

  const hostname = document.createElement("span");
  hostname.className = "row-hostname";
  hostname.title = session.sourceUrl || "";
  hostname.textContent = session.hostname || "—";

  const badgesWrap = document.createElement("span");
  badgesWrap.className = "row-badges";
  badgesWrap.innerHTML = `
    <span class="badge provider">${providerLabel(session.provider)}</span>
    <span class="badge">${session.imageCount} img</span>
    <span class="badge">${formatDuration(session.duration)}</span>
  `;

  const timeEl = document.createElement("span");
  timeEl.className = "row-time";
  timeEl.dataset.savedat = session.savedAt;
  timeEl.style.cursor = "pointer";
  timeEl.title = "Click to toggle time format";
  timeEl.textContent = useAbsoluteTime ? formatTime(session.savedAt) : formatTimeAgo(session.savedAt);

  row.appendChild(checkbox);
  row.appendChild(hostname);
  row.appendChild(badgesWrap);
  row.appendChild(timeEl);

  // Checkbox: shift-click multi-select
  checkbox.addEventListener("click", (e) => {
    e.stopPropagation();
    const allCheckboxes = [...document.querySelectorAll(".card-select")];
    const currentIndex = allCheckboxes.indexOf(checkbox);
    if (e.shiftKey && lastCheckedIndex !== null) {
      const lo = Math.min(lastCheckedIndex, currentIndex);
      const hi = Math.max(lastCheckedIndex, currentIndex);
      const targetState = checkbox.checked;
      allCheckboxes.slice(lo, hi + 1).forEach(cb => { cb.checked = targetState; });
    }
    lastCheckedIndex = currentIndex;
    syncSelectionFromDOM();
    updateExportSelectedVisibility();
    updateGroupSelectionState();
    updateImagesViewSelection();
  });

  row.addEventListener("click", (e) => {
    if (e.target.classList.contains("card-select")) return;
    openDetail(session.sessionId);
  });

  return row;
}

function updateGroupSelectionState() {
  document.querySelectorAll(".session-group").forEach(group => {
    const checkboxes = group.querySelectorAll(".card-select");
    const checkedCount = group.querySelectorAll(".card-select:checked").length;
    const groupCheckbox = group.querySelector(".group-select");
    const header = group.querySelector(".group-header");

    if (groupCheckbox) {
      groupCheckbox.checked = checkedCount === checkboxes.length && checkboxes.length > 0;
      groupCheckbox.indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
    }
    if (header) {
      header.classList.toggle("has-selection", checkedCount > 0);
    }
  });

  updateExportSelectedVisibility();
}

async function loadThumbnailsForCard(session) {
  // Thumbnails are only used in Images View now, this function is deprecated
  const thumbsContainer = document.getElementById(`thumbs-${session.sessionId}`);
  if (!thumbsContainer || thumbsContainer.dataset.loaded) return;

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

  cardBlobUrls.set(session.sessionId, blobUrls);
  thumbsContainer.dataset.loaded = "1";
}

// ============================================
// Date-based grouping
// ============================================

function groupByDate(sessions) {
  const groups = {};
  for (const session of sessions) {
    const dateKey = new Date(session.savedAt).toISOString().slice(0, 10);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(session);
  }
  // Sort date keys descending (newest first)
  const sortedKeys = Object.keys(groups).sort().reverse();
  return sortedKeys.map(dateKey => ({
    dateKey,
    displayDate: formatDateHeader(dateKey),
    sessions: groups[dateKey]
  }));
}

const fmtAbsTime = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function updateAllGroupTimeRanges() {
  document.querySelectorAll(".group-time-range[data-lo]").forEach(btn => {
    const lo = parseInt(btn.dataset.lo);
    const hi = parseInt(btn.dataset.hi);
    if (groupTimeAbsolute) {
      btn.textContent = lo === hi ? fmtAbsTime(lo) : `${fmtAbsTime(lo)} – ${fmtAbsTime(hi)}`;
    } else {
      const loAgo = formatTimeAgo(new Date(lo).toISOString());
      const hiAgo = formatTimeAgo(new Date(hi).toISOString());
      btn.textContent = lo === hi ? loAgo : `${loAgo} – ${hiAgo}`;
    }
  });
}

function buildGroupPanel(group) {
  const panel = document.createElement("div");
  panel.className = "session-group";
  panel.dataset.date = group.dateKey;

  const count = group.sessions.length;

  const header = document.createElement("div");
  header.className = "group-header";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "group-select";
  checkbox.dataset.date = group.dateKey;

  const titleSpan = document.createElement("span");
  titleSpan.className = "group-title";
  titleSpan.textContent = group.displayDate;

  const countSpan = document.createElement("span");
  countSpan.className = "group-count";
  countSpan.textContent = `${count} recording${count !== 1 ? "s" : ""}`;

  // Time range toggle (absolute ↔ relative) — synced globally
  const times = group.sessions.map(s => new Date(s.savedAt).getTime()).filter(Boolean);
  const timeRangeBtn = document.createElement("button");
  timeRangeBtn.className = "group-time-range";
  if (times.length === 0) {
    timeRangeBtn.style.display = "none";
  } else {
    const lo = Math.min(...times), hi = Math.max(...times);
    timeRangeBtn.dataset.lo = lo;
    timeRangeBtn.dataset.hi = hi;
    // Set initial text to match current global state
    if (groupTimeAbsolute) {
      timeRangeBtn.textContent = lo === hi ? fmtAbsTime(lo) : `${fmtAbsTime(lo)} – ${fmtAbsTime(hi)}`;
    } else {
      const loAgo = formatTimeAgo(new Date(lo).toISOString());
      const hiAgo = formatTimeAgo(new Date(hi).toISOString());
      timeRangeBtn.textContent = lo === hi ? loAgo : `${loAgo} – ${hiAgo}`;
    }
  }
  timeRangeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    groupTimeAbsolute = !groupTimeAbsolute;
    updateAllGroupTimeRanges();
  });

  header.appendChild(checkbox);
  header.appendChild(titleSpan);
  header.appendChild(timeRangeBtn);
  header.appendChild(countSpan);

  const body = document.createElement("div");
  body.className = "group-body";

  // Track time clusters for visual spacing
  let lastCluster = null;

  for (const session of group.sessions) {
    const cluster = getTimeCluster(session.savedAt);
    const card = buildCardElement(session);
    card.dataset.date = group.dateKey;

    // Add spacing between time clusters
    if (lastCluster && cluster !== lastCluster) {
      card.classList.add("cluster-gap");
    }
    lastCluster = cluster;

    body.appendChild(card);
  }

  // Group checkbox selects all sessions in this date.
  // Note: .group-header has user-select:none which can prevent Firefox from toggling
  // checkbox.checked on click when appearance:none is set. To avoid reading a stale
  // pre-click state, we derive the desired checked value from the card states instead.
  checkbox.addEventListener("click", (e) => {
    e.stopPropagation();
    const cardCheckboxes = [...body.querySelectorAll(".card-select")];
    const allChecked = cardCheckboxes.every(cb => cb.checked);
    const checked = !allChecked; // if all were checked → deselect; otherwise → select all
    checkbox.checked = checked;
    checkbox.indeterminate = false;
    cardCheckboxes.forEach(cb => { cb.checked = checked; });
    header.classList.toggle("has-selection", checked);
    for (const session of group.sessions) {
      if (checked) selectedSessionMap.set(session.sessionId, session.imageCount);
      else selectedSessionMap.delete(session.sessionId);
    }
    updateGroupSelectionState();
    updateExportSelectedVisibility();
    updateImagesViewSelection();
  });

  panel.appendChild(header);
  panel.appendChild(body);
  return panel;
}

// ============================================
// Load Page (Recordings or Images view)
// ============================================

async function loadPage() {
  if (isLoading) { pendingReload = true; return; }
  isLoading = true;
  pendingReload = false;

  const hostnameFilter = document.getElementById("filter-hostname").value.trim();
  const providerFilter = document.getElementById("filter-provider").value;

  const filter = {};
  if (hostnameFilter) filter.hostname = hostnameFilter;
  if (providerFilter) filter.provider = providerFilter;
  if (currentFilter.hasImages) filter.hasImages = currentFilter.hasImages;
  if (currentTimeFilter) {
    if (currentTimeFilter.timeFrom) filter.timeFrom = currentTimeFilter.timeFrom;
    if (currentTimeFilter.timeTo)   filter.timeTo   = currentTimeFilter.timeTo;
    if (currentTimeFilter.dateRange) filter.dateRange = currentTimeFilter.dateRange();
  }
  currentFilter = { ...currentFilter, ...filter };

  // Reset shift-select state across page loads
  lastCheckedIndex = null;

  const list = document.getElementById("session-list");

  // Clear existing content, revoking blob URLs
  for (const group of list.querySelectorAll(".session-group, .date-group")) {
    for (const el of group.querySelectorAll(".session-row, img")) {
      const sid = el.dataset?.sessionId;
      if (sid) {
        for (const url of (cardBlobUrls.get(sid) || [])) URL.revokeObjectURL(url);
        cardBlobUrls.delete(sid);
      }
    }
    group.remove();
  }

  document.getElementById("load-more").style.display = "none";

  try {
    const resp = await portRequest("get-sessions", { offset: 0, limit: 500, filter });
    const sessions = resp.sessions || [];

    // Track filtered counts for stats bar
    const hasFilter = hostnameFilter || providerFilter || currentFilter.hasImages ||
      (currentTimeFilter && currentTimeFilter.id !== "all");
    if (hasFilter) {
      filteredSessionCount = sessions.length;
      filteredImageCount = sessions.reduce((sum, s) => sum + (s.imageCount || 0), 0);
    } else {
      filteredSessionCount = null;
      filteredImageCount = null;
      // Derive totals directly from the unfiltered result so stats are
      // always fresh after any loadPage() call (avoids timing races with
      // archive-stats-updated port messages).
      totalSessions = sessions.length;
      totalImages = sessions.reduce((sum, s) => sum + (s.imageCount || 0), 0);
    }
    updateStatsDisplay();

    if (sessions.length === 0) {
      document.getElementById("empty-state").style.display = "block";
    } else {
      document.getElementById("empty-state").style.display = "none";

      if (currentView === "recordings") {
        renderRecordingsView(sessions, list);
      } else {
        await renderImagesView(sessions, list);
      }
    }
    currentOffset = sessions.length;
  } catch (e) {
    console.error("[DIARY sidebar] loadPage failed:", e);
  }

  isLoading = false;
  if (pendingReload) loadPage();
}

function renderRecordingsView(sessions, list) {
  for (const group of groupByDate(sessions)) {
    list.appendChild(buildGroupPanel(group));
  }
}

async function renderImagesView(sessions, list) {
  lightboxImages = [];
  lbList = [];
  lbIdx = 0;
  isGlobalLightbox = true;
  const groups = groupByDate(sessions);

  for (const group of groups) {
    const panel = document.createElement("div");
    panel.className = "date-group";
    panel.dataset.date = group.dateKey;

    const header = document.createElement("div");
    header.className = "group-header images-view-header";

    const titleSpan = document.createElement("span");
    titleSpan.className = "group-title";
    titleSpan.textContent = group.displayDate;

    // Count total images in this date group
    const totalImages = group.sessions.reduce((sum, s) => sum + s.imageCount, 0);
    const countSpan = document.createElement("span");
    countSpan.className = "group-count";
    countSpan.textContent = `${totalImages} image${totalImages !== 1 ? "s" : ""}`;

    header.appendChild(titleSpan);
    header.appendChild(countSpan);
    panel.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "images-grid";

    // Load all images for all sessions in this date group
    for (const session of group.sessions) {
      for (let i = 0; i < session.imageCount; i++) {
        const imageId = `${session.sessionId}-img-${String(i).padStart(3, "0")}`;
        const thumb = await loadImageThumbnail(imageId, session.sessionId, i);
        if (thumb) grid.appendChild(thumb);
      }
    }

    panel.appendChild(grid);
    list.appendChild(panel);
  }
  updateImagesViewSelection();
}

async function loadImageThumbnail(imageId, sessionId, index) {
  try {
    const resp = await browser.runtime.sendMessage({ action: "get-image", imageId });
    if (resp && resp.image && resp.image.blob) {
      const url = URL.createObjectURL(resp.image.blob);

      // Track blob URL for cleanup
      if (!cardBlobUrls.has(sessionId)) cardBlobUrls.set(sessionId, []);
      cardBlobUrls.get(sessionId).push(url);

      const wrap = document.createElement("div");
      wrap.className = "grid-thumb-wrap";
      wrap.dataset.sessionId = sessionId;

      const img = document.createElement("img");
      img.className = "grid-thumb";
      img.src = url;
      img.alt = `Image ${index + 1}`;
      const globalIdx = lightboxImages.length;
      lightboxImages.push({ url, isSceneCapture: false, sessionId, lbIndex: globalIdx });
      img.dataset.lbIndex = globalIdx;
      img.addEventListener("click", () => openLightbox(url, globalIdx));

      wrap.appendChild(img);
      return wrap;
    }
  } catch (e) {
    console.error("[DIARY] loadImageThumbnail failed:", e);
  }
  return null;
}

// ============================================
// Cursor SVG Export
// ============================================

async function openCursorSvg(sessionId) {
  const [cursorResp, sessionResp] = await Promise.all([
    browser.runtime.sendMessage({ action: "get-cursors", sessionId }),
    browser.runtime.sendMessage({ action: "get-session-detail", sessionId })
  ]);

  // Only top-frame points share a coordinate space with each other and with
  // captcha element rects. iframe points use that iframe's viewport origin and
  // would warp the coordinate range when mixed with top-frame points.
  const pts = (cursorResp?.cursors?.points || []).filter(p => (p.frameDepth ?? 0) === 0);
  if (pts.length < 2) return;

  // Captcha element rects — top-frame detections only (same viewport space as cursor points)
  const elements = (sessionResp?.session?.captchaElements || [])
    .filter(el => el.rect && el.rect.width > 0 && el.rect.height > 0 && (el.frameDepth ?? 0) === 0);

  // Downsample, preserving temporal distribution
  const MAX = 600;
  let sampled;
  if (pts.length > MAX) {
    const sorted = [...pts].sort((a, b) => a.t - b.t);
    const minT0 = sorted[0].t, maxT0 = sorted[sorted.length - 1].t;
    const step = (maxT0 - minT0) / (MAX - 1);
    sampled = Array.from({ length: MAX }, (_, i) => {
      const target = minT0 + i * step;
      return sorted.reduce((best, p) =>
        Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best
      );
    });
    sampled = sampled.filter((p, i) => i === 0 || p !== sampled[i - 1]);
  } else {
    sampled = [...pts].sort((a, b) => a.t - b.t);
  }

  const ptTs = sampled.map(p => p.t);
  const minT = Math.min(...ptTs), maxT = Math.max(...ptTs);
  const dT = maxT - minT || 1;

  // Use the recorded viewport dimensions as the coordinate space.
  // Cursor clientX/clientY and captcha getBoundingClientRect() are both in
  // [0, viewport.width] × [0, viewport.height] — mapping directly gives the
  // correct aspect ratio and avoids the data-range trap (e.g. cursor barely
  // moved horizontally → dW tiny → H explodes).
  const vp = sessionResp?.session?.viewport || {};
  const vW = vp.width  || 1440;
  const vH = vp.height || 900;

  const W = 800, pad = 32;
  const H = Math.round(W * vH / vW);
  const nx = x => (x / vW * (W - 2 * pad) + pad).toFixed(1);
  const ny = y => (y / vH * (H - 2 * pad) + pad).toFixed(1);
  const sw = w => (w / vW * (W - 2 * pad)).toFixed(1);
  const sh = h => (h / vH * (H - 2 * pad)).toFixed(1);

  // Visual trail path
  const d = sampled.map((p, i) => `${i === 0 ? "M" : "L"}${nx(p.x)},${ny(p.y)}`).join(" ");

  // Cadence-preserving animation
  const keyTimes = sampled.map(p => ((p.t - minT) / dT).toFixed(5)).join(";");
  const values   = sampled.map(p => `${nx(p.x)},${ny(p.y)}`).join(";");
  const dur = Math.max(1, dT / 1000).toFixed(2);

  // CAPTCHA element bounds overlay
  // Sort by area descending: largest = outermost container, smallest = innermost target
  const sortedEls = [...elements].sort(
    (a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height)
  );
  const n = sortedEls.length;

  // Rects — no inline text labels
  const rectsSvg = sortedEls.map(el => {
    const x = nx(el.rect.left), y = ny(el.rect.top);
    const w = sw(el.rect.width), h = sh(el.rect.height);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(251,191,36,0.04)" stroke="#E85548" stroke-width="1" stroke-dasharray="5,3" opacity="0.7"/>`;
  }).join("\n\t");

  // Labels stacked in top-left corner, indented to mirror HTML nesting structure.
  // Depth of element i = number of sortedEls[j < i] whose rect strictly contains el's rect.
  const labelsSvg = sortedEls.map((el, i) => {
    const depth = sortedEls.slice(0, i).filter(anc =>
      anc.rect.left <= el.rect.left && anc.rect.right  >= el.rect.right &&
      anc.rect.top  <= el.rect.top  && anc.rect.bottom >= el.rect.bottom
    ).length;
    const raw = (el.selector || el.frameUrl || `element ${i + 1}`).slice(0, 48);
    const label = raw || `element ${i + 1}`;
    const x = pad + 4 + depth * 12;
    const y = pad + 12 + i * 15;
    return `<text x="${x}" y="${y}" fill="#E85548" font-family="monospace" font-size="10" opacity="1">${label}</text>`;
  }).join("\n  ");

  const elementsSvg = rectsSvg + (n > 0 ? "\n  " + labelsSvg : "");

  // Signature — lower-left, like a plein air sketch
  const session = sessionResp?.session || {};
  // recordedAt = new Date(recordingStartTime).toISOString() set in main.js at recording start
  const dt = new Date(session.recordedAt || session.savedAt || Date.now());
  const timeStr = dt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateStr = dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const durMs = session.duration || 0;
  const durS  = Math.round(durMs / 1000);
  const durStr = durS >= 60 ? `${Math.floor(durS / 60)}m ${durS % 60}s` : `${durS}s`;
  const vpStr = session.viewport ? `${session.viewport.width} × ${session.viewport.height}` : "";
  const srcStr = (session.sourceUrl || session.hostname || "").slice(0, 52);
  const sigLines = [
    `${timeStr}  ·  ${dateStr}`,
    srcStr,
    [durStr, vpStr].filter(Boolean).join("  ·  ")
  ];
  const sigY0 = H - pad - (sigLines.length - 1) * 14;
  const sigSvg = sigLines.map((line, i) =>
    `<text x="${pad + 4}" y="${sigY0 + i * 14}" fill="#ffffff" font-family="monospace" font-size="9">${line}</text>`
  ).join("\n  ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="background:#09090b;display:block">
  ${elementsSvg}
  <path d="${d}" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.3" stroke-linecap="round" stroke-linejoin="round"/>
  <circle r="3" fill="#ffffff" opacity="0.8">
    <animateMotion dur="${dur}s" repeatCount="indefinite" calcMode="linear"
      keyTimes="${keyTimes}"
      values="${values}"
    />
  </circle>
  ${sigSvg}
</svg>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Approx. Cursor Trace</title><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#09090b;display:flex;justify-content:center;align-items:center;min-height:100vh}
  svg{max-width:90vw;max-height:90vh;width:auto;height:auto}
</style></head><body>${svg}</body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ============================================
// Detail View
// ============================================

async function openDetail(sessionId) {
  currentDetailSessionId = sessionId;

  for (const url of detailBlobUrls) URL.revokeObjectURL(url);
  detailBlobUrls.length = 0;
  lightboxImages = [];
  lbList = [];
  lbIdx = 0;
  isGlobalLightbox = false;

  const overlay = document.getElementById("detail-overlay");
  overlay.classList.remove("hidden");

  const body = document.getElementById("detail-body");
  body.innerHTML = "<p style='color:#9ca3af;padding:20px 0;text-align:center'>Loading…</p>";

  try {
    const resp = await browser.runtime.sendMessage({ action: "get-session-detail", sessionId });
    const session = resp.session;
    if (!session) { body.innerHTML = "<p style='color:#ef4444;padding:20px 0'>Recording not found.</p>"; return; }

    document.getElementById("detail-title").textContent = session.hostname || "Recording";

    let html = "";

    // Metadata section (single-column list, label left, value right)
    html += `<div class="detail-section">
      <div class="detail-meta-list">
        <div class="detail-meta-row">
          <span class="meta-label">Saved at</span>
          <span class="meta-value">${formatDate(session.savedAt)}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Source URL</span>
          <span class="meta-value"${session.sourceUrl ? ` data-copy-url="${escapeHtml(session.sourceUrl)}" style="cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;vertical-align:bottom" title="Click to copy"` : ""}>${escapeHtml(session.sourceUrl || "—")}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Session ID</span>
          <span class="meta-value" style="font-family:monospace;cursor:pointer" title="Click to copy" data-copy-id="${session.sessionId}">${session.sessionId.slice(0, 16)}…</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Provider</span>
          <span class="meta-value">${providerLabel(session.provider)}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Duration</span>
          <span class="meta-value">~${formatDuration(session.duration)}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Images</span>
          <span class="meta-value">${session.imageCount}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Trigger</span>
          <span class="meta-value">${session.exportTrigger || "—"}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Cursor pts</span>
          <span class="meta-value">${session.cursorPointCount.toLocaleString()}${session.cursorPointCount > 1 ? ` <span class="meta-link" data-action="cursor-svg" style="margin-left:6px;cursor:pointer;color:var(--text-dim);font-size:10px">SVG</span>` : ""}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Viewport</span>
          <span class="meta-value">${session.viewport ? `${session.viewport.width}×${session.viewport.height}` : "—"}</span>
        </div>
        <div class="detail-meta-row">
          <span class="meta-label">Rounds</span>
          <span class="meta-value">${session.rounds}</span>
        </div>
      </div>
    </div>`;

    // CAPTCHA elements (monospace dark pills)
    if (session.captchaElements && session.captchaElements.length > 0) {
      html += `<div class="detail-section">
        <div class="detail-section-title">Detected Elements</div>`;
      for (const el of session.captchaElements) {
        html += `<div class="detected-element">${escapeHtml(el.selector)}</div>`;
      }
      html += `</div>`;
    }

    // Images grid (5 columns, populated asynchronously below)
    html += `<div class="detail-section">
      <div class="detail-section-title">${session.imageCount === 0 ? "NO IMAGES" : "Images"}</div>
      <div class="detail-images-grid" id="detail-images-grid"></div>
    </div>`;

    // Notes with autosave
    html += `<div class="detail-section">
      <div class="detail-section-title">Notes</div>
      <textarea class="notes-textarea" id="detail-notes" placeholder="Quick notes here...">${escapeHtml(session.notes || "")}</textarea>
      <div class="notes-footer">
        <button class="btn-sm" id="notes-save-btn">Save</button>
        <span class="notes-status" id="notes-status"></span>
      </div>
    </div>`;

    body.innerHTML = html;

    // Session ID copy-on-click in detail meta
    const copyEl = body.querySelector("[data-copy-id]");
    if (copyEl) {
      copyEl.title = "Click to copy full session ID";
      copyEl.addEventListener("click", () => {
        navigator.clipboard.writeText(copyEl.dataset.copyId).then(() => {
          const prev = copyEl.textContent;
          copyEl.textContent = "Copied!";
          copyEl.style.color = "var(--badge-provider-text)";
          setTimeout(() => {
            copyEl.textContent = prev;
            copyEl.style.color = "";
          }, 1500);
        }).catch(() => {});
      });
    }

    // Source URL copy-on-click
    const urlCopyEl = body.querySelector("[data-copy-url]");
    if (urlCopyEl) {
      urlCopyEl.addEventListener("click", () => {
        navigator.clipboard.writeText(urlCopyEl.dataset.copyUrl).then(() => {
          const prev = urlCopyEl.textContent;
          urlCopyEl.textContent = "Copied!";
          setTimeout(() => { urlCopyEl.textContent = prev; }, 1500);
        }).catch(() => {});
      });
    }

    // Cursor SVG link
    const svgLink = body.querySelector("[data-action='cursor-svg']");
    if (svgLink) {
      svgLink.addEventListener("click", () => openCursorSvg(sessionId));
    }

    // Load images into grid and populate lightboxImages array
    const grid = document.getElementById("detail-images-grid");
    if (grid) {
      for (let i = 0; i < session.imageCount; i++) {
        const imageId = `${sessionId}-img-${String(i).padStart(3, "0")}`;
        try {
          const imgResp = await browser.runtime.sendMessage({ action: "get-image", imageId });
          if (imgResp && imgResp.image && imgResp.image.blob) {
            const url = URL.createObjectURL(imgResp.image.blob);
            detailBlobUrls.push(url);
            const isScene = (imgResp.image.url || "").startsWith("scene-capture:");
            const idx = lightboxImages.length;
            lightboxImages.push({ url, isSceneCapture: isScene, lbIndex: idx });

            const wrap = document.createElement("div");
            wrap.className = "detail-img-wrap";

            const img = document.createElement("img");
            img.className = "detail-img";
            img.src = url;
            img.alt = `Image ${i + 1}`;
            img.dataset.lbIndex = idx;
            img.addEventListener("click", () => openLightbox(url, idx));
            wrap.appendChild(img);

            if (isScene) {
              const badge = document.createElement("div");
              badge.className = "detail-img-scene-badge";
              badge.textContent = "Scene";
              wrap.appendChild(badge);
            }

            grid.appendChild(wrap);
          }
        } catch (e) {}
      }
    }

    // Notes: autosave + explicit save button
    const notesTextarea = document.getElementById("detail-notes");
    const notesStatus = document.getElementById("notes-status");
    const notesSaveBtn = document.getElementById("notes-save-btn");
    let notesDebounce = null;

    const saveNotes = async () => {
      const notes = notesTextarea.value;
      await browser.runtime.sendMessage({ action: "update-session-notes", sessionId, notes });
      notesStatus.textContent = "Saved";
      setTimeout(() => { notesStatus.textContent = ""; }, 2000);
    };

    if (notesTextarea) {
      notesTextarea.addEventListener("input", () => {
        clearTimeout(notesDebounce);
        notesStatus.textContent = "";
        notesDebounce = setTimeout(saveNotes, 800);
      });
    }
    if (notesSaveBtn) {
      notesSaveBtn.addEventListener("click", () => {
        clearTimeout(notesDebounce);
        saveNotes();
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
  lightboxImages = [];
}

// ============================================
// Lightbox (Steps 4)
// ============================================

function setLbActive(entry) {
  document.querySelectorAll("[data-lb-index].lb-active").forEach(el => el.classList.remove("lb-active"));
  if (entry != null) {
    const el = document.querySelector(`[data-lb-index="${entry.lbIndex}"]`);
    if (el) el.classList.add("lb-active");
  }
}

function openLightbox(_url, globalIdx) {
  // When sessions are selected in images view, restrict navigation to those sessions
  const entry = lightboxImages[globalIdx];
  if (isGlobalLightbox && selectedSessionMap.size > 0) {
    lbList = lightboxImages.filter(e => selectedSessionMap.has(e.sessionId));
  } else {
    lbList = lightboxImages;
  }
  lbIdx = lbList.indexOf(entry);
  if (lbIdx < 0) { lbList = lightboxImages; lbIdx = globalIdx; } // fallback
  const cur = lbList[lbIdx];
  document.getElementById("lightbox-img").src = cur.url;
  document.getElementById("lb-scene-badge").style.display = cur.isSceneCapture ? "block" : "none";
  document.getElementById("lightbox").classList.remove("hidden");
  setLbActive(cur);
}

function closeLightbox() {
  document.getElementById("lightbox").classList.add("hidden");
  document.getElementById("lightbox-img").src = "";
  document.getElementById("lb-scene-badge").style.display = "none";
  setLbActive(null);
}

function navigateLightbox(dir) {
  if (lbList.length === 0) return;
  lbIdx = (lbIdx + dir + lbList.length) % lbList.length;
  const cur = lbList[lbIdx];
  document.getElementById("lightbox-img").src = cur.url;
  document.getElementById("lb-scene-badge").style.display = cur.isSceneCapture ? "block" : "none";
  setLbActive(cur);
}

document.getElementById("lightbox").addEventListener("click", (e) => {
  if (e.target.id === "lb-prev" || e.target.id === "lb-next") return;
  closeLightbox();
});

document.getElementById("lb-prev").addEventListener("click", (e) => {
  e.stopPropagation();
  navigateLightbox(-1);
});

document.getElementById("lb-next").addEventListener("click", (e) => {
  e.stopPropagation();
  navigateLightbox(+1);
});

document.addEventListener("keydown", (e) => {
  const lightboxHidden = document.getElementById("lightbox").classList.contains("hidden");
  if (!lightboxHidden) {
    if (e.key === "ArrowLeft")  navigateLightbox(-1);
    if (e.key === "ArrowRight") navigateLightbox(+1);
    if (e.key === "Escape") { closeLightbox(); return; }
  }
  if (e.key === "Escape") {
    hideContextMenu();
    const checked = [...document.querySelectorAll(".card-select:checked")];
    if (checked.length > 0 || selectedSessionMap.size > 0) {
      checked.forEach(cb => { cb.checked = false; });
      selectedSessionMap.clear();
      updateGroupSelectionState();
      updateExportSelectedVisibility();
      updateImagesViewSelection();
    }

    const searchEl = document.getElementById("filter-hostname");
    if (searchEl.value) {
      searchEl.value = "";
      searchEl.blur();
      clearTimeout(filterDebounce);
      if (currentView !== "recordings") {
        currentView = "recordings";
        document.querySelectorAll(".view-toggle").forEach(t => t.classList.remove("active"));
        document.getElementById("view-recordings").classList.add("active");
      }
      loadPage();
    }
  }
});

// ============================================
// Export & Context Menu
// ============================================

function getCheckedSessionIds() {
  return [...selectedSessionMap.keys()];
}

// Sync DOM checkbox states → selectedSessionMap (call after any checkbox change)
function syncSelectionFromDOM() {
  document.querySelectorAll(".card-select").forEach(cb => {
    const imageCount = parseInt(cb.closest("[data-image-count]")?.dataset.imageCount || 0);
    if (cb.checked) selectedSessionMap.set(cb.dataset.sessionId, imageCount);
    else selectedSessionMap.delete(cb.dataset.sessionId);
  });
}

function updateExportSelectedVisibility() {
  const count = getCheckedSessionIds().length;
  const btn = document.getElementById("export-all-btn");

  if (count > 0) {
    btn.textContent = `Export selected (${count})`;
    btn.dataset.mode = "selected";
  } else {
    btn.textContent = "Export all";
    btn.dataset.mode = "all";
  }
  updateStatsDisplay();
}

// Export button in header (exports all or selected based on state)
document.getElementById("export-all-btn").addEventListener("click", () => {
  const ids = getCheckedSessionIds();
  if (ids.length > 0) {
    // Show context menu next to the button for export options
    const btn = document.getElementById("export-all-btn");
    const rect = btn.getBoundingClientRect();
    showContextMenu(rect.left, rect.bottom + 4);
  } else {
    // No selection, export all
    browser.runtime.sendMessage({ action: "export-zip", sessionIds: [] });
  }
});

// Context menu handling
const contextMenu = document.getElementById("context-menu");

function showContextMenu(x, y) {
  contextMenu.classList.remove("hidden");

  // Position menu, keeping it within viewport
  const rect = contextMenu.getBoundingClientRect();
  const menuWidth = 180;
  const menuHeight = 140;

  let posX = x;
  let posY = y;

  if (x + menuWidth > window.innerWidth) posX = window.innerWidth - menuWidth - 10;
  if (y + menuHeight > window.innerHeight) posY = window.innerHeight - menuHeight - 10;

  contextMenu.style.left = posX + "px";
  contextMenu.style.top = posY + "px";
}

function hideContextMenu() {
  contextMenu.classList.add("hidden");
}

function updateImagesViewSelection() {
  if (currentView !== "images") return;
  const selected = new Set(getCheckedSessionIds());
  const anySelected = selected.size > 0;
  document.querySelectorAll(".grid-thumb-wrap").forEach(wrap => {
    const isSelected = selected.has(wrap.dataset.sessionId);
    wrap.classList.toggle("session-selected", isSelected);
    wrap.classList.toggle("session-dimmed", anySelected && !isSelected);
  });
}

// Hide context menu on click outside (but not when clicking the export button that opened it)
document.addEventListener("click", (e) => {
  if (!contextMenu.contains(e.target) && !e.target.closest("#export-all-btn")) {
    hideContextMenu();
  }
});

// Context menu actions
document.querySelectorAll(".menu-item").forEach(item => {
  item.addEventListener("click", async () => {
    const action = item.dataset.action;
    const ids = getCheckedSessionIds();

    hideContextMenu();

    if (ids.length === 0) return;

    if (action === "export-full") {
      browser.runtime.sendMessage({ action: "export-zip", sessionIds: ids });
    } else if (action === "export-flat") {
      browser.runtime.sendMessage({ action: "export-zip-flat", sessionIds: ids });
    } else if (action === "delete") {
      if (!confirm(`Delete ${ids.length} recording${ids.length !== 1 ? "s" : ""}? This cannot be undone.`)) return;
      for (const sessionId of ids) {
        await browser.runtime.sendMessage({ action: "delete-session", sessionId });
      }
      await loadPage();
      await updateStats();
    }
  });
});

document.getElementById("detail-export-btn").addEventListener("click", () => {
  if (currentDetailSessionId) {
    browser.runtime.sendMessage({ action: "export-zip", sessionIds: [currentDetailSessionId] });
  }
});

document.getElementById("detail-delete-btn").addEventListener("click", async () => {
  if (!currentDetailSessionId) return;
  if (!confirm("Delete this recording? This cannot be undone.")) return;
  await browser.runtime.sendMessage({ action: "delete-session", sessionId: currentDetailSessionId });
  closeDetail();
});

// ============================================
// Filters
// ============================================

function commitCurrentFilter() {
  const hostnameFilter = document.getElementById("filter-hostname").value.trim();
  const providerFilter = document.getElementById("filter-provider").value;
  const hasImages      = currentFilter.hasImages || "";
  const timeFilterId   = currentTimeFilter?.id || "all";
  saveRecentFilter({ hostname: hostnameFilter, provider: providerFilter, hasImages, timeFilterId });
}

let filterDebounce = null;
document.getElementById("filter-hostname").addEventListener("input", () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => loadPage(), 300);
});
// Save recent filter only when the user finishes typing (blur or Enter).
document.getElementById("filter-hostname").addEventListener("blur", commitCurrentFilter);
document.getElementById("filter-hostname").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { clearTimeout(filterDebounce); loadPage(); commitCurrentFilter(); }
});

document.getElementById("filter-provider").addEventListener("change", () => {
  loadPage();
  commitCurrentFilter();
});

// ── Time filter panel ─────────────────────────────────────────────────────

function setTimeFilter(id) {
  const tf = TIME_FILTERS.find(t => t.id === id) || null;
  currentTimeFilter = (tf && tf.id !== "all") ? tf : null;

  const trigger = document.getElementById("time-filter-trigger");
  if (trigger) {
    trigger.textContent = tf ? tf.label : "All time";
    trigger.classList.toggle("active-filter", !!currentTimeFilter);
  }

  // Update active state on panel items
  document.querySelectorAll(".time-filter-item").forEach(el => {
    el.classList.toggle("active", el.dataset.filterId === (id || "all"));
  });
}

document.getElementById("time-filter-trigger")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (currentTimeFilter) {
    // Filter is active — clicking trigger resets to All time
    setTimeFilter("all");
    document.getElementById("time-filter-panel")?.classList.add("hidden");
    loadPage();
    commitCurrentFilter();
  } else {
    // No filter active — open/close the panel
    document.getElementById("time-filter-panel")?.classList.toggle("hidden");
  }
});

document.querySelectorAll(".time-filter-item").forEach(el => {
  el.addEventListener("click", () => {
    setTimeFilter(el.dataset.filterId);
    document.getElementById("time-filter-panel")?.classList.add("hidden");
    loadPage();
    commitCurrentFilter();
  });
});

document.addEventListener("click", (e) => {
  const panel = document.getElementById("time-filter-panel");
  const trigger = document.getElementById("time-filter-trigger");
  if (panel && !panel.contains(e.target) && e.target !== trigger) {
    panel.classList.add("hidden");
  }
});

// ============================================
// Navigation & View Toggle
// ============================================

document.getElementById("back-btn").addEventListener("click", closeDetail);

document.getElementById("load-more-btn").addEventListener("click", () => {
  loadPage();
});

// Time format toggle: click any row-time to switch all between hh:mm and "x ago"
document.getElementById("session-list").addEventListener("click", (e) => {
  const timeEl = e.target.closest(".row-time");
  if (!timeEl) return;
  e.stopPropagation();
  useAbsoluteTime = !useAbsoluteTime;
  document.querySelectorAll(".row-time[data-savedat]").forEach(el => {
    el.textContent = useAbsoluteTime ? formatTime(el.dataset.savedat) : formatTimeAgo(el.dataset.savedat);
  });
});

// View toggle (Recordings / Images)
document.querySelectorAll(".view-toggle").forEach(el => {
  el.addEventListener("click", () => {
    const view = el.dataset.view;
    if (view === currentView) return;

    currentView = view;
    document.querySelectorAll(".view-toggle").forEach(t => t.classList.remove("active"));
    el.classList.add("active");
    loadPage();
  });
});

// ============================================
// Header toggles: dark mode, image filter
// ============================================

document.getElementById("refresh-btn").addEventListener("click", () => loadPage());

document.getElementById("dark-mode-btn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("diaryTheme", next);
  document.getElementById("theme-icon").src = `sidebar-icons/themeToggle-${next}.svg`;
});

// 3-state image filter cycle: all → with images → no images
const imageFilterStates = ["", "yes", "no"];
const imageFilterLabels = ["All recordings", "With images only", "No images only"];
const imageFilterIcons = ["records-all.svg", "records-hasImg.svg", "records-noImg.svg"];
let imageFilterIndex = 0;

function updateImagesFilterIcon() {
  document.getElementById("images-filter-icon").src = `sidebar-icons/${imageFilterIcons[imageFilterIndex]}`;
}

document.getElementById("toggle-images-btn").addEventListener("click", () => {
  imageFilterIndex = (imageFilterIndex + 1) % imageFilterStates.length;
  const state = imageFilterStates[imageFilterIndex];
  currentFilter.hasImages = state;

  const btn = document.getElementById("toggle-images-btn");
  btn.dataset.tooltip = imageFilterLabels[imageFilterIndex];
  btn.classList.toggle("active", state !== "");
  updateImagesFilterIcon();

  loadPage();
});

// ============================================
// Init
// ============================================

async function init() {
  // Restore persisted theme — dark is default
  const savedTheme = localStorage.getItem("diaryTheme") || "dark";
  document.documentElement.dataset.theme = savedTheme;
  document.getElementById("theme-icon").src = `sidebar-icons/themeToggle-${savedTheme}.svg`;
  updateImagesFilterIcon();

  // Render any saved recent filters
  renderRecentFilters();

  // Narrow sidebar: hide badges when width is 300–350px
  const resizeObs = new ResizeObserver(entries => {
    const w = entries[0].contentRect.width;
    // document.body.classList.toggle("narrow", w >= 300 && w <= 350);
    document.body.classList.toggle("narrow", w <= 350);
    document.body.classList.toggle("too-narrow", w < 280);
  });
  resizeObs.observe(document.body);

  await updateStats();
  await populateFilters();
  await loadPage();
}

init();