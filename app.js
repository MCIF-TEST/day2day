/* Discipline Checklist (robust persistence, Phoenix-locked reset)
   - Resets ONLY at 2:00am America/Phoenix by discipline-day key rollover
   - Primary persistence: IndexedDB (reliable across close/reopen)
   - Fallback: localStorage
   - Write-through autosave on changes + visibility/pagehide
*/

(() => {
  "use strict";

  // ====== CONFIG ======
  const RESET_HOUR_PHOENIX = 2;
  const PHX_TZ = "America/Phoenix";

  const DB_NAME = "discipline_checklist_db";
  const DB_VERSION = 1;
  const STORE_NAME = "kv";
  const KV_KEY = "state_v3";

  const LS_FALLBACK_KEY = "discipline.checklist.fallback.v3";
  const HISTORY_DAYS_TO_KEEP = 90;

  // User wants GED optional INCLUDED in completion %
  const EXCLUDE_OPTIONAL_FROM_PERCENT = false;

  // ====== TASKS ======
  const BASE_TASKS = [
    { id: "wake_5am", label: "Wake up at 5am", desc: "Start on time.", required: true },
    { id: "pushups_50", label: "50 push ups", desc: "Strict form.", required: true },
    { id: "squats_50", label: "50 squats", desc: "Controlled reps.", required: true },
    { id: "pullups_25", label: "25 pull ups outside", desc: "Full range.", required: true },
    { id: "bible_30", label: "Read Bible 30 mins", desc: "Timer: 30:00.", required: true },
    { id: "journal_am", label: "Journal (morning)", desc: "Plan, intention, focus.", required: true },
    { id: "ged_optional", label: "Study GED", desc: "Optional, but counts in %.", required: false },
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
  const btnResetDay = $("#btnResetDay");
  const btnMarkAll = $("#btnMarkAll");

  // ====== UTILS ======
  const pad2 = (n) => String(n).padStart(2, "0");

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  function nowMs() { return Date.now(); }

  // ====== PHOENIX TIME CORE ======
  function getTimeZoneOffsetMinutes(timeZone, date = new Date()) {
    // Prefer modern "shortOffset" if supported
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

    // Phoenix has no DST; fallback is always UTC-07:00
    return -7 * 60;
  }

  function phoenixOffsetMs(now = new Date()) {
    return getTimeZoneOffsetMinutes(PHX_TZ, now) * 60 * 1000;
  }

  // Phoenix "wall time epoch", represented as pseudo-UTC in ms.
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

  // Discipline day key = date of (Phoenix wall time - 2 hours)
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

  // ====== STORAGE ENGINE (IndexedDB + fallback) ======
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

  async function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error("IDB get failed"));
    });
  }

  async function idbPut(db, key, value) {
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

  // ====== STATE MODEL ======
  function defaultState() {
    return {
      version: 3,
      updatedAt: nowMs(),
      activeDayKey: null,
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
    if (!state.days[dayKey]) {
      state.days[dayKey] = { createdAt: nowMs(), completed: {} };
    }
    const rec = state.days[dayKey];

    for (const t of tasks) {
      if (typeof rec.completed[t.id] !== "boolean") rec.completed[t.id] = false;
    }
    const valid = new Set(tasks.map(t => t.id));
    for (const id of Object.keys(rec.completed)) {
      if (!valid.has(id)) delete rec.completed[id];
    }
  }

  // ====== SAVE COALESCING ======
  let saveInFlight = false;
  let saveQueued = false;
  let lastSaveOk = false;
  let storageMode = "IDB"; // or "LS"

  async function persist(state, db) {
    // Coalesce rapid saves into one at a time
    if (saveInFlight) { saveQueued = true; return; }
    saveInFlight = true;

    try {
      state.updatedAt = nowMs();

      // Primary: IDB
      if (db) {
        await idbPut(db, KV_KEY, state);
        lastSaveOk = true;
        storageMode = "IDB";
        // Also write fallback snapshot occasionally (best-effort)
        lsPut(state);
      } else {
        // Fallback: localStorage only
        lastSaveOk = lsPut(state);
        storageMode = "LS";
      }
    } catch {
      // If IDB write fails, fallback to LS
      lastSaveOk = lsPut(state);
      storageMode = "LS";
    } finally {
      saveInFlight = false;
      if (saveQueued) { saveQueued = false; await persist(state, db); }
    }
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function statusSavedLine(now = new Date()) {
    const ok = lastSaveOk ? "OK" : "FAIL";
    return `Saved(${ok}) via ${storageMode} • ${formatPhoenixNow(now)}`;
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
        setStatus(statusSavedLine(new Date()));
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
    setStatus(`Marked all • ${statusSavedLine(new Date())}`);
  }

  async function resetToday(state, db) {
    const dayKey = state.activeDayKey;
    const { tasks } = tasksForDay(dayKey);
    const rec = state.days[dayKey];
    for (const t of tasks) rec.completed[t.id] = false;

    render(dayKey, state, db);
    await persist(state, db);
    setStatus(`Reset today • ${statusSavedLine(new Date())}`);
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
      setStatus(`New discipline day loaded • ${statusSavedLine(now)}`);
    }
  }

  // ====== LOAD ======
  async function loadState(db) {
    // Try IDB first
    if (db) {
      try {
        const s = await idbGet(db, KV_KEY);
        if (s && typeof s === "object") return s;
      } catch { /* ignore */ }
    }
    // Fallback localStorage
    const ls = lsGet();
    if (ls && typeof ls === "object") return ls;

    return defaultState();
  }

  // ====== BOOT ======
  async function boot() {
    let db = null;
    try { db = await openDb(); } catch { db = null; }

    const state = await loadState(db);

    const now = new Date();
    const dayKey = getDisciplineDayKey(now);
    state.activeDayKey = dayKey;

    const { tasks } = tasksForDay(dayKey);
    ensureDayRecord(state, dayKey, tasks);
    pruneOldDays(state);

    render(dayKey, state, db);
    await persist(state, db);
    setStatus(`Ready • ${statusSavedLine(now)}`);

    // Buttons
    btnMarkAll.addEventListener("click", () => markAll(state, db));
    btnResetDay.addEventListener("click", async () => {
      const ok = confirm("Reset TODAY (current discipline day) back to unchecked?");
      if (ok) await resetToday(state, db);
    });

    // Hardening: save on tab hide / page close
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "hidden") {
        await persist(state, db);
      }
    });

    // iOS Safari friendly: pagehide fires reliably on close/app switch
    window.addEventListener("pagehide", async () => {
      await persist(state, db);
    });

    // Run tick immediately, then every second to keep countdown & catch 2am quickly
    await tick(state, db);
    setInterval(() => { tick(state, db); }, 1000);
  }

  boot();
})();