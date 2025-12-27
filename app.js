/* Warrior Checklist (industry-grade persistence + themes)
   - Phoenix locked discipline day reset at 2:00am America/Phoenix
   - Robust persistence: IndexedDB primary + localStorage snapshot fallback
   - Save hardening: on change + visibilitychange + pagehide + periodic flush
   - Cross-tab sync via BroadcastChannel
   - Requests persistent storage to reduce eviction risk
   - Device ID stored per device/browser
*/

(() => {
  "use strict";

  // ====== CONFIG ======
  const RESET_HOUR_PHOENIX = 2;
  const PHX_TZ = "America/Phoenix";

  // IndexedDB
  const DB_NAME = "warrior_checklist_db";
  const DB_VERSION = 1;
  const STORE_NAME = "kv";
  const KV_KEY = "state_v4";

  // localStorage snapshot fallback
  const LS_FALLBACK_KEY = "warrior.checklist.snapshot.v4";

  // Cross-tab sync
  const CHANNEL_NAME = "warrior_checklist_channel_v4";

  // Housekeeping
  const HISTORY_DAYS_TO_KEEP = 120;

  // Optional items INCLUDED in % (per your earlier rule)
  const EXCLUDE_OPTIONAL_FROM_PERCENT = false;

  // ====== THEMES ======
  const THEME_IDS = ["warrior", "iron", "stealth", "desert", "christian"];

  // ====== TASKS ======
  const BASE_TASKS = [
    { id: "wake_5am", label: "Wake up at 5am", desc: "Start on time.", required: true },
    { id: "pushups_50", label: "50 push ups", desc: "Strict form.", required: true },
    { id: "squats_50", label: "50 squats", desc: "Controlled reps.", required: true },
    { id: "pullups_25", label: "25 pull ups outside", desc: "Full range.", required: true },
    { id: "bible_30", label: "Read Bible 30 mins", desc: "Timer: 30:00.", required: true },
    { id: "journal_am", label: "Journal (morning)", desc: "Plan, intention, focus.", required: true },
    { id: "ged_optional", label: "Study GED", desc: "Optional (counts in %).", required: false },
    { id: "hillsdale", label: "Study Hillsdale class", desc: "Show up daily.", required: true },
    { id: "study_ai_45", label: "Study AI 45 mins", desc: "Timer: 45:00.", required: true },
    { id: "meditate_10", label: "Meditate 10 mins", desc: "Timer: 10:00.", required: true },
    { id: "journal_pm", label: "Journal (evening)", desc: "Review, accountability.", required: true },
    { id: "misc_read_30", label: "Read misc book 30 mins", desc: "Timer: 30:00.", required: true },
  ];

  const FASTING_TASK = {
    id: "fasting_day",
    label: "Fasting day",
    desc: "Wednesday + Sunday only.",
    required: true,
    special: "fasting",
  };

  // ====== DOM ======
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#list");
  const dayKeyEl = $("#dayKey");
  const phxNowEl = $("#phxNow");
  const countdownEl = $("#countdown");
  const fastingPillEl = $("#fastingPill");
  const pctEl = $("#pct");
  const doneCountEl = $("#doneCount");
  const needCountEl = $("#needCount");
  const barFillEl = $("#barFill");
  const statusEl = $("#status");
  const storageInfoEl = $("#storageInfo");
  const btnResetDay = $("#btnResetDay");
  const btnMarkAll = $("#btnMarkAll");
  const themeSelectEl = $("#themeSelect");

  // ====== UTILS ======
  const pad2 = (n) => String(n).padStart(2, "0");
  const nowMs = () => Date.now();

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function stableStringify(obj) {
    // Simple stable stringify for hashing-ish consistency (industry-ish; not cryptographic)
    const seen = new WeakSet();
    const sorter = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

    const walk = (x) => {
      if (x && typeof x === "object") {
        if (seen.has(x)) return null;
        seen.add(x);
        if (Array.isArray(x)) return x.map(walk);
        const out = {};
        for (const k of Object.keys(x).sort(sorter)) out[k] = walk(x[k]);
        return out;
      }
      return x;
    };

    return JSON.stringify(walk(obj));
  }

  function makeId() {
    try {
      return crypto.randomUUID();
    } catch {
      // fallback
      return "dev_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
    }
  }

  // ====== PHOENIX TIME CORE ======
  function getTimeZoneOffsetMinutes(timeZone, date = new Date()) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "shortOffset",
        hour: "2-digit",
        minute: "2-digit",
      });
      const parts = fmt.formatToParts(date);
      const tzPart = parts.find(p => p.type === "timeZoneName")?.value || "";
      const m = tzPart.match(/([+-])(\d{2}):?(\d{2})/);
      if (m) {
        const sign = m[1] === "-" ? -1 : 1;
        return sign * (Number(m[2]) * 60 + Number(m[3]));
      }
    } catch { /* fall through */ }

    // Phoenix no DST fallback
    return -7 * 60;
  }

  function phoenixOffsetMs(now = new Date()) {
    return getTimeZoneOffsetMinutes(PHX_TZ, now) * 60 * 1000;
  }

  // Phoenix wall epoch represented as pseudo-UTC
  function phoenixWallEpoch(now = new Date()) {
    return now.getTime() + phoenixOffsetMs(now);
  }

  function formatPhoenixNow(now = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: PHX_TZ,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
    return fmt.format(now);
  }

  // Discipline day key = date of (Phoenix wall time - resetHour)
  function getDisciplineDayKey(now = new Date()) {
    const shifted = phoenixWallEpoch(now) - RESET_HOUR_PHOENIX * 60 * 60 * 1000;
    const d = new Date(shifted);
    const y = d.getUTCFullYear();
    const m = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    return `${y}-${m}-${day}`;
  }

  function parseDayKeyToPhoenixNoonWallEpoch(dayKey) {
    const [y, m, d] = dayKey.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  }

  function isFastingDay(dayKey) {
    const noonWall = parseDayKeyToPhoenixNoonWallEpoch(dayKey);
    const dow = new Date(noonWall).getUTCDay(); // 0 Sun, 3 Wed
    return dow === 0 || dow === 3;
  }

  function nextResetRealEpoch(now = new Date()) {
    const offMs = phoenixOffsetMs(now);
    const phxWall = now.getTime() + offMs;
    const phxWallDate = new Date(phxWall);

    const y = phxWallDate.getUTCFullYear();
    const m = phxWallDate.getUTCMonth();
    const d = phxWallDate.getUTCDate();

    let resetWall = Date.UTC(y, m, d, RESET_HOUR_PHOENIX, 0, 0, 0);
    if (phxWall >= resetWall) resetWall = Date.UTC(y, m, d + 1, RESET_HOUR_PHOENIX, 0, 0, 0);

    return resetWall - offMs;
  }

  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }

  // ====== TASK SET ======
  function tasksForDay(dayKey) {
    const fasting = isFastingDay(dayKey);
    const tasks = fasting ? [FASTING_TASK, ...BASE_TASKS] : [...BASE_TASKS];
    return { tasks, fasting };
  }

  // ====== STORAGE (IndexedDB + snapshot fallback) ======
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB not supported"));
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error("IDB get failed"));
    });
  }

  function idbPut(db, key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error || new Error("IDB put failed"));
    });
  }

  function lsGet() {
    return safeJsonParse(localStorage.getItem(LS_FALLBACK_KEY), null);
  }
  function lsPut(value) {
    try {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const granted = await navigator.storage.persist();
        return !!granted;
      }
    } catch { /* ignore */ }
    return false;
  }

  async function storageEstimate() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        return await navigator.storage.estimate();
      }
    } catch { /* ignore */ }
    return null;
  }

  // ====== STATE MODEL ======
  function defaultState() {
    return {
      version: 4,
      updatedAt: nowMs(),
      deviceId: makeId(),
      activeDayKey: null,
      themeId: "warrior",
      days: {} // dayKey -> { createdAt, completed: {id:boolean} }
    };
  }

  function pruneOldDays(state) {
    const keys = Object.keys(state.days).sort();
    const extra = keys.length - HISTORY_DAYS_TO_KEEP;
    if (extra <= 0) return;
    for (let i = 0; i < extra; i++) delete state.days[keys[i]];
  }

  function ensureDayRecord(state, dayKey, tasks) {
    if (!state.days[dayKey]) state.days[dayKey] = { createdAt: nowMs(), completed: {} };
    const rec = state.days[dayKey];

    for (const t of tasks) {
      if (typeof rec.completed[t.id] !== "boolean") rec.completed[t.id] = false;
    }

    const valid = new Set(tasks.map(t => t.id));
    for (const id of Object.keys(rec.completed)) {
      if (!valid.has(id)) delete rec.completed[id];
    }
  }

  function sanitizeThemeId(themeId) {
    return THEME_IDS.includes(themeId) ? themeId : "warrior";
  }

  // ====== PERSISTENCE (coalesced + hardened) ======
  let saveInFlight = false;
  let saveQueued = false;
  let lastSaveOk = false;
  let storageMode = "IDB";
  let lastSavedHash = "";

  async function persist(state, db) {
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;

    try {
      state.updatedAt = nowMs();

      const hash = stableStringify({
        updatedAt: state.updatedAt,
        activeDayKey: state.activeDayKey,
        themeId: state.themeId,
        deviceId: state.deviceId,
        days: state.days
      });
      // Avoid redundant writes if nothing changed except tick UI
      if (hash === lastSavedHash) {
        lastSaveOk = true;
        return;
      }

      if (db) {
        await idbPut(db, KV_KEY, state);
        storageMode = "IDB";
        lastSaveOk = true;
        // Best-effort snapshot
        lsPut(state);
      } else {
        storageMode = "LS";
        lastSaveOk = lsPut(state);
      }

      lastSavedHash = hash;
    } catch {
      storageMode = "LS";
      lastSaveOk = lsPut(state);
    } finally {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; await persist(state, db); }
    }
  }

  function statusSavedLine(now = new Date()) {
    const ok = lastSaveOk ? "OK" : "FAIL";
    return `Saved(${ok}) via ${storageMode} • ${formatPhoenixNow(now)}`;
  }

  // ====== UI / THEMES ======
  function applyTheme(themeId) {
    document.body.dataset.theme = sanitizeThemeId(themeId);
    if (themeSelectEl) themeSelectEl.value = sanitizeThemeId(themeId);
  }

  // ====== PROGRESS ======
  function computeProgress(tasks, completedMap) {
    const eligible = tasks.filter(t => {
      if (!EXCLUDE_OPTIONAL_FROM_PERCENT) return true;
      return t.required !== false;
    });

    const total = eligible.length;
    const done = eligible.reduce((acc, t) => acc + (completedMap[t.id] ? 1 : 0), 0);
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    return { done, total, pct };
  }

  function refreshProgress(dayKey, state) {
    const { tasks } = tasksForDay(dayKey);
    const rec = state.days[dayKey];
    const { done, total, pct } = computeProgress(tasks, rec.completed);

    doneCountEl.textContent = String(done);
    needCountEl.textContent = String(total);
    pctEl.textContent = `${pct}%`;
    barFillEl.style.width = `${pct}%`;
  }

  // ====== RENDER ======
  function render(dayKey, state, db) {
    const { tasks, fasting } = tasksForDay(dayKey);
    ensureDayRecord(state, dayKey, tasks);

    dayKeyEl.textContent = dayKey;
    fastingPillEl.style.display = fasting ? "inline-flex" : "none";

    const rec = state.days[dayKey];
    listEl.innerHTML = "";

    for (const t of tasks) {
      const row = document.createElement("div");
      row.className = "item";
      row.setAttribute("role", "listitem");

      const left = document.createElement("div");
      left.className = "left";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!rec.completed[t.id];
      cb.setAttribute("aria-label", t.label);

      cb.addEventListener("change", async () => {
        rec.completed[t.id] = cb.checked;
        refreshProgress(dayKey, state);
        await persist(state, db);
        statusEl.textContent = statusSavedLine(new Date());
        broadcastState(state);
      }, { passive: true });

      const meta = document.createElement("div");
      meta.className = "meta";

      const labelRow = document.createElement("div");
      labelRow.className = "labelRow";

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = t.label;

      const tag = document.createElement("span");
      tag.className = "tag";

      if (t.special === "fasting") tag.classList.add("fasting");
      else if (t.required) tag.classList.add("required");
      else tag.classList.add("optional");

      tag.textContent = (t.special === "fasting") ? "FASTING" : (t.required ? "REQUIRED" : "OPTIONAL");

      const desc = document.createElement("div");
      desc.className = "desc";
      desc.textContent = t.desc || "";

      labelRow.appendChild(label);
      labelRow.appendChild(tag);
      meta.appendChild(labelRow);
      meta.appendChild(desc);

      left.appendChild(cb);
      left.appendChild(meta);
      row.appendChild(left);
      listEl.appendChild(row);
    }

    refreshProgress(dayKey, state);
  }

  // ====== ACTIONS ======
  async function markAll(state, db) {
    const dayKey = state.activeDayKey;
    const { tasks } = tasksForDay(dayKey);
    const rec = state.days[dayKey];
    for (const t of tasks) rec.completed[t.id] = true;

    render(dayKey, state, db);
    await persist(state, db);
    statusEl.textContent = `Marked all • ${statusSavedLine(new Date())}`;
    broadcastState(state);
  }

  async function resetToday(state, db) {
    const dayKey = state.activeDayKey;
    const { tasks } = tasksForDay(dayKey);
    const rec = state.days[dayKey];
    for (const t of tasks) rec.completed[t.id] = false;

    render(dayKey, state, db);
    await persist(state, db);
    statusEl.textContent = `Reset today • ${statusSavedLine(new Date())}`;
    broadcastState(state);
  }

  // ====== CROSS-TAB SYNC ======
  let bc = null;

  function openChannel() {
    try {
      if ("BroadcastChannel" in window) {
        bc = new BroadcastChannel(CHANNEL_NAME);
        bc.onmessage = (ev) => {
          const msg = ev?.data;
          if (!msg || msg.type !== "STATE") return;
          // Only accept if from same deviceId (avoids weird merges if you copy state)
          // If you *want* shared merges across copied states, remove this guard.
          // We'll still accept theme change even if day differs.
          onIncomingState(msg.payload);
        };
      }
    } catch {
      bc = null;
    }
  }

  function broadcastState(state) {
    if (!bc) return;
    try {
      bc.postMessage({
        type: "STATE",
        payload: {
          deviceId: state.deviceId,
          updatedAt: state.updatedAt,
          activeDayKey: state.activeDayKey,
          themeId: state.themeId,
          days: state.days
        }
      });
    } catch { /* ignore */ }
  }

  function onIncomingState(payload) {
    if (!payload || typeof payload !== "object") return;
    // We only merge if same deviceId to keep it “this device remembers”
    if (payload.deviceId && appState.deviceId && payload.deviceId !== appState.deviceId) return;

    // If incoming is newer, merge and rerender
    if (typeof payload.updatedAt === "number" && payload.updatedAt > appState.updatedAt) {
      appState.updatedAt = payload.updatedAt;
      appState.activeDayKey = payload.activeDayKey || appState.activeDayKey;
      appState.themeId = sanitizeThemeId(payload.themeId || appState.themeId);
      if (payload.days && typeof payload.days === "object") appState.days = payload.days;

      applyTheme(appState.themeId);
      const dk = appState.activeDayKey || getDisciplineDayKey(new Date());
      render(dk, appState, dbRef);
      statusEl.textContent = `Synced from other tab • ${formatPhoenixNow(new Date())}`;
    }
  }

  // ====== AUTO-RESET / TICK ======
  async function tick(state, db) {
    const now = new Date();
    phxNowEl.textContent = formatPhoenixNow(now);

    const nextReset = nextResetRealEpoch(now);
    countdownEl.textContent = formatCountdown(nextReset - now.getTime());

    const currentKey = getDisciplineDayKey(now);
    if (state.activeDayKey !== currentKey) {
      state.activeDayKey = currentKey;

      const { tasks } = tasksForDay(currentKey);
      ensureDayRecord(state, currentKey, tasks);
      pruneOldDays(state);

      render(currentKey, state, db);
      await persist(state, db);
      statusEl.textContent = `New discipline day loaded • ${statusSavedLine(now)}`;
      broadcastState(state);
    }
  }

  // ====== LOAD ======
  async function loadState(db) {
    if (db) {
      try {
        const s = await idbGet(db, KV_KEY);
        if (s && typeof s === "object") return s;
      } catch { /* ignore */ }
    }
    const snap = lsGet();
    if (snap && typeof snap === "object") return snap;
    return defaultState();
  }

  // ====== GLOBALS FOR SYNC HANDLER ======
  let dbRef = null;
  let appState = null;

  // ====== BOOT ======
  async function boot() {
    // DB open
    try { dbRef = await openDb(); } catch { dbRef = null; }

    // Load state
    appState = await loadState(dbRef);

    // Ensure deviceId persists (device memory)
    if (!appState.deviceId) appState.deviceId = makeId();

    // Theme sanity
    appState.themeId = sanitizeThemeId(appState.themeId || "warrior");
    applyTheme(appState.themeId);

    // Set day key
    const now = new Date();
    const dayKey = getDisciplineDayKey(now);
    appState.activeDayKey = dayKey;

    const { tasks } = tasksForDay(dayKey);
    ensureDayRecord(appState, dayKey, tasks);
    pruneOldDays(appState);

    // Cross-tab channel
    openChannel();

    // Theme selector
    if (themeSelectEl) {
      themeSelectEl.value = appState.themeId;
      themeSelectEl.addEventListener("change", async () => {
        const chosen = sanitizeThemeId(themeSelectEl.value);
        appState.themeId = chosen;
        applyTheme(chosen);
        await persist(appState, dbRef);
        statusEl.textContent = `Theme set: ${chosen} • ${statusSavedLine(new Date())}`;
        broadcastState(appState);
      });
    }

    // Initial render + save
    render(dayKey, appState, dbRef);
    await persist(appState, dbRef);
    statusEl.textContent = `Ready • ${statusSavedLine(now)}`;

    // Storage durability details
    const persisted = await requestPersistentStorage();
    const est = await storageEstimate();
    const quota = est?.quota ? Math.round(est.quota / (1024 * 1024)) : null;
    const usage = est?.usage ? Math.round(est.usage / (1024 * 1024)) : null;

    storageInfoEl.textContent =
      `Device: ${appState.deviceId.slice(0, 8)}… • Persist: ${persisted ? "ON" : "OFF"}`
      + (quota != null && usage != null ? ` • Storage: ${usage}MB/${quota}MB` : "");

    // Buttons
    btnMarkAll.addEventListener("click", () => markAll(appState, dbRef));
    btnResetDay.addEventListener("click", async () => {
      const ok = confirm("Reset TODAY (current discipline day) back to unchecked?");
      if (ok) await resetToday(appState, dbRef);
    });

    // Save on tab hide / close (iOS friendly)
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "hidden") {
        await persist(appState, dbRef);
      }
    });

    window.addEventListener("pagehide", async () => {
      await persist(appState, dbRef);
    });

    // Periodic safety flush (in case of odd browser conditions)
    setInterval(() => { persist(appState, dbRef); }, 30_000);

    // Tick loop: countdown + 2am rollover
    await tick(appState, dbRef);
    setInterval(() => { tick(appState, dbRef); }, 1000);
  }

  boot();
})();