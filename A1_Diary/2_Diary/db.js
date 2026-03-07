// db.js - IndexedDB wrapper for CAPTCHA Diary
// Loaded as the first background script. Exposes global `db` object.
// Stores: sessions (metadata), images (blobs), cursors (point arrays), archive_meta (totals)

const db = (() => {
  const DB_NAME = "captcha-diary-db";
  const DB_VERSION = 1;
  let _db = null;

  // ============================================
  // Schema
  // ============================================

  function _onUpgradeNeeded(event) {
    const d = event.target.result;

    // Session metadata — no cursor points inline (kept in cursors store)
    if (!d.objectStoreNames.contains("sessions")) {
      const sessions = d.createObjectStore("sessions", { keyPath: "sessionId" });
      sessions.createIndex("by_savedAt", "savedAt", { unique: false });
      sessions.createIndex("by_hostname", "hostname", { unique: false });
      sessions.createIndex("by_provider", "provider", { unique: false });
    }

    // Image blobs — stored as Blob objects, never as base64 strings
    if (!d.objectStoreNames.contains("images")) {
      const images = d.createObjectStore("images", { keyPath: "imageId" });
      images.createIndex("by_sessionId", "sessionId", { unique: false });
    }

    // Cursor point arrays — one record per session, fetched only in detail view
    if (!d.objectStoreNames.contains("cursors")) {
      d.createObjectStore("cursors", { keyPath: "sessionId" });
    }

    // Archive-wide running totals — single record keyed "global"
    if (!d.objectStoreNames.contains("archive_meta")) {
      d.createObjectStore("archive_meta", { keyPath: "key" });
    }
  }

  // ============================================
  // Open / init
  // ============================================

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = _onUpgradeNeeded;
      request.onsuccess = (event) => {
        _db = event.target.result;
        // Handle unexpected version change / database deletion
        _db.onversionchange = () => {
          _db.close();
          _db = null;
        };
        resolve(_db);
      };
      request.onerror = (event) => reject(event.target.error);
      request.onblocked = () => console.warn("[DIARY-DB] Open blocked by another connection");
    });
  }

  // ============================================
  // Helper: wrap IDB request in Promise
  // ============================================

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ============================================
  // Sessions
  // ============================================

  async function saveSession(record) {
    const d = await open();
    const tx = d.transaction("sessions", "readwrite");
    return wrap(tx.objectStore("sessions").put(record));
  }

  async function getSession(sessionId) {
    const d = await open();
    return wrap(d.transaction("sessions").objectStore("sessions").get(sessionId));
  }

  // Returns array of session records (no blobs, no cursor points) for archive listing.
  // Sorted newest-first via by_savedAt index descending.
  // Applies optional filter: { hostname, provider, hasImages, timeFrom, timeTo, dateRange: { from, to } }
  // hostname is matched as a case-insensitive substring against hostname, sessionId, and notes.
  async function getSessions(offset = 0, limit = 20, filter = {}) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("sessions");
      const index = tx.objectStore("sessions").index("by_savedAt");
      const results = [];
      let skipped = 0;

      // Open cursor descending (newest first)
      const req = index.openCursor(null, "prev");
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor || results.length >= limit) {
          resolve(results);
          return;
        }

        const record = cursor.value;
        const matches = _matchesFilter(record, filter);

        if (matches) {
          if (skipped < offset) {
            skipped++;
          } else {
            results.push(record);
          }
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _matchesFilter(record, filter) {
    // Hostname/sessionId/notes: case-insensitive substring match
    if (filter.hostname) {
      const term = filter.hostname.toLowerCase();
      const matchesHost  = (record.hostname  || "").toLowerCase().includes(term);
      const matchesId    = (record.sessionId || "").toLowerCase().includes(term);
      const matchesNotes = (record.notes     || "").toLowerCase().includes(term);
      if (!matchesHost && !matchesId && !matchesNotes) return false;
    }
    if (filter.provider && record.provider !== filter.provider) return false;
    // Has-images filter
    if (filter.hasImages === "yes" && !(record.imageCount > 0)) return false;
    if (filter.hasImages === "no"  &&   record.imageCount > 0)  return false;
    // Time-of-day filter (HH:MM strings)
    if (filter.timeFrom || filter.timeTo) {
      const d = new Date(record.savedAt);
      const hhmm = d.getHours() * 60 + d.getMinutes();
      const [fh, fm] = (filter.timeFrom || "00:00").split(":").map(Number);
      const [th, tm] = (filter.timeTo   || "23:59").split(":").map(Number);
      if (hhmm < fh * 60 + fm || hhmm > th * 60 + tm) return false;
    }
    if (filter.dateRange) {
      const savedAt = new Date(record.savedAt).getTime();
      if (filter.dateRange.from && savedAt < new Date(filter.dateRange.from).getTime()) return false;
      if (filter.dateRange.to && savedAt > new Date(filter.dateRange.to).getTime()) return false;
    }
    return true;
  }

  async function updateSessionNotes(sessionId, notes) {
    const d = await open();
    const tx = d.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const session = await wrap(store.get(sessionId));
    if (!session) return;
    session.notes = notes;
    return wrap(store.put(session));
  }

  async function deleteSession(sessionId) {
    const d = await open();

    // Delete all images for this session
    const imageIds = await new Promise((resolve, reject) => {
      const tx = d.transaction("images");
      const req = tx.objectStore("images").index("by_sessionId").getAllKeys(sessionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = d.transaction(["sessions", "images", "cursors", "archive_meta"], "readwrite");
    const sessionStore = tx.objectStore("sessions");
    const imageStore = tx.objectStore("images");
    const cursorStore = tx.objectStore("cursors");
    const metaStore = tx.objectStore("archive_meta");

    // Get session to know counts for meta update
    const session = await wrap(sessionStore.get(sessionId));
    const imageCount = session ? session.imageCount : 0;
    const cursorPointCount = session ? session.cursorPointCount : 0;

    // Delete images
    for (const imageId of imageIds) {
      imageStore.delete(imageId);
    }

    // Delete cursor record
    cursorStore.delete(sessionId);

    // Delete session
    sessionStore.delete(sessionId);

    // Update archive_meta
    const meta = await wrap(metaStore.get("global"));
    if (meta) {
      meta.totalSessions = Math.max(0, meta.totalSessions - 1);
      meta.totalImages = Math.max(0, meta.totalImages - imageCount);
      meta.totalCursorPoints = Math.max(0, meta.totalCursorPoints - cursorPointCount);
      meta.lastUpdatedAt = new Date().toISOString();
      metaStore.put(meta);
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============================================
  // Images
  // ============================================

  async function saveImage(record) {
    const d = await open();
    return wrap(d.transaction("images", "readwrite").objectStore("images").put(record));
  }

  async function getImage(imageId) {
    const d = await open();
    return wrap(d.transaction("images").objectStore("images").get(imageId));
  }

  async function getImagesForSession(sessionId) {
    const d = await open();
    return wrap(d.transaction("images").objectStore("images").index("by_sessionId").getAll(sessionId));
  }

  // ============================================
  // Cursors
  // ============================================

  async function saveCursors(sessionId, points) {
    const d = await open();
    return wrap(d.transaction("cursors", "readwrite").objectStore("cursors").put({ sessionId, points }));
  }

  async function getCursors(sessionId) {
    const d = await open();
    return wrap(d.transaction("cursors").objectStore("cursors").get(sessionId));
  }

  // ============================================
  // Archive Meta
  // ============================================

  const DEFAULT_META = {
    key: "global",
    totalSessions: 0,
    totalImages: 0,
    totalCursorPoints: 0,
    lastUpdatedAt: null
  };

  async function getArchiveMeta() {
    const d = await open();
    const result = await wrap(d.transaction("archive_meta").objectStore("archive_meta").get("global"));
    return result || { ...DEFAULT_META };
  }

  // deltaSessions, deltaImages, deltaCursorPoints: positive integers to add
  async function updateArchiveMeta(deltaSessions, deltaImages, deltaCursorPoints) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("archive_meta", "readwrite");
      const store = tx.objectStore("archive_meta");
      const req = store.get("global");
      req.onsuccess = () => {
        const current = req.result || { ...DEFAULT_META };
        current.totalSessions += deltaSessions;
        current.totalImages += deltaImages;
        current.totalCursorPoints += deltaCursorPoints;
        current.lastUpdatedAt = new Date().toISOString();
        store.put(current);
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ============================================
  // Distinct value helpers (for filter dropdowns)
  // ============================================

  async function getDistinctHostnames() {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("sessions");
      const index = tx.objectStore("sessions").index("by_hostname");
      const results = new Set();
      const req = index.openKeyCursor(null, "nextunique");
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve([...results]); return; }
        results.add(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getDistinctProviders() {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("sessions");
      const index = tx.objectStore("sessions").index("by_provider");
      const results = new Set();
      const req = index.openKeyCursor(null, "nextunique");
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve([...results]); return; }
        results.add(cursor.key);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ============================================
  // Public API
  // ============================================

  return {
    open,
    // Sessions
    saveSession,
    getSession,
    getSessions,
    updateSessionNotes,
    deleteSession,
    // Images
    saveImage,
    getImage,
    getImagesForSession,
    // Cursors
    saveCursors,
    getCursors,
    // Archive meta
    getArchiveMeta,
    updateArchiveMeta,
    // Filter helpers
    getDistinctHostnames,
    getDistinctProviders
  };
})();
