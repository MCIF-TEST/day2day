/* Industry-grade daily checklist (client-only)
   - Stores progress per "discipline day" in localStorage
   - Discipline day boundary = 2:00am America/Phoenix (not device timezone)
   - Auto-resets at/after 2:00am Phoenix by switching dayKey
   - Adds required "Fasting day" item on Wed + Sun (Phoenix-based)
   - Data model versioning + pruning
*/

(() => {
  "use strict";

  // ====== CONFIG ======
  const RESET_HOUR_PHOENIX = 2; // 2:00am America/Phoenix
  const PHX_TZ = "America/Phoenix";
  const STORAGE_KEY = "discipline.checklist.v2";
  const HISTORY_DAYS_TO_KEEP = 60;

  // User clarified: OPTIONAL ITEMS ARE INCLUDED IN COMPLETION %
  const EXCLUDE_OPTIONAL_FROM_PERCENT = false;

  const BASE_TASKS = [
    { id: "wake_5am", label: "Wake up at 5am", desc: "Start on time.", required: true },
    { id: "pushups_50", label: "50 push ups", desc: "Strict form.", required: true },
    { id: "squats_50", label: "50 squats", desc: "Controlled reps.", required: true },
    { id: "pullups_25", label: "25 pull ups outside", desc: "Full range.", required: true },
    { id: "bible_30", label: "Read Bible 30 mins", desc: "Timer: 30:00.", required: true },
    { id: "journal_am", label: "Journal (morning)", desc: "Plan, intention, focus.", required: true },
    { id: "ged_optional", label: "Study GED", desc: "Optional.", required: false },
    { id: "hillsdale", label: "Study Hillsdale class", desc: "Show up daily.", required: true },
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

  // ====== UTIL ======
  const pad2 = (n) => String(n).padStart(2, "0");

  function safeJsonParse(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  // ====== PHOENIX TIME CORE ======
  // We compute Phoenix "wall time" using the timezone's offset at the current instant.
  // Then we do all date logic in a "pseudo-UTC" space where getUTC* methods represent Phoenix wall time.

  function getTimeZoneOffsetMinutes(timeZone, date = new Date()) {
    // Prefer modern "shortOffset" (e.g., "GMT-07:00")
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        timeZoneName: "shortOffset",
        hour: "2-digit",
        minute: "2-digit",
      });
      const parts = fmt.formatToParts(date);
      const tzPart = parts.find(p => p.type === "timeZoneName")?.value || "";
      // tzPart like "GMT-07:00" or "UTC-07:00"
      const m = tzPart.match(/([+-])(\d{2}):?(\d{2})/);
      if (m) {
        const sign = m[1] === "-" ? -1 : 1;
        const hh = Number(m[2]);
        const mm = Number(m[3]);
        return sign * (hh * 60 + mm);
      }
    } catch { /* fall through */ }

    // Phoenix is effectively always UTC-07:00 (no DST). Fallback:
    return -7 * 60;
  }

  function phoenixOffsetMs(now = new Date()) {
    return getTimeZoneOffsetMinutes(PHX_TZ, now) * 60 * 1000;
  }

  // "Phoenix wall clock epoch" (ms) represented as if it were UTC.
  function phoenixWallEpoch(now = new Date()) {
    return now.getTime() + phoenixOffsetMs(now);
  }

  function formatPhoenixNow(now = new Date()) {
    // Format nicely using Intl with Phoenix TZ.
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

  // Discipline day key: date of (Phoenix wall time - RESET_HOUR)
  function getDisciplineDayKey(now = new Date()) {
    const phxWall = phoenixWallEpoch(now);
    const shifted = phxWall - RESET_HOUR_PHOENIX * 60 * 60 * 1000;
    const d = new Date(shifted);
    const y = d.getUTCFullYear();
    const m = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    return `${y}-${m}-${day}`;
  }

  function parseDayKeyToPhoenixNoonWallEpoch(dayKey) {
    const [y, m, d] = dayKey.split("-").map(Number);
    // Noon wall time in Phoenix, represented as pseudo-UTC:
    return Date.UTC(y, m - 1, d, 12, 0, 0, 0);
  }

  function isFastingDay(dayKey) {
    // Phoenix day of week based on the discipline dayKey
    const noonWall = parseDayKeyToPhoenixNoonWallEpoch(dayKey);
    const dow = new Date(noonWall).getUTCDay(); // 0=Sun ... 3=Wed
    return dow === 0 || dow === 3;
  }

  // Next reset instant in REAL epoch ms, based on Phoenix 2:00am.
  function nextResetRealEpoch(now = new Date()) {
    const offMs = phoenixOffsetMs(now);
    const phxWall = now.getTime() + offMs;
    const phxWallDate = new Date(phxWall);

    const y = phxWallDate.getUTCFullYear();
    const m = phxWallDate.getUTCMonth();
    const d = phxWallDate.getUTCDate();

    let resetWall = Date.UTC(y, m, d, RESET_HOUR_PHOENIX, 0, 0, 0);
    if (phxWall >= resetWall) {
      resetWall = Date.UTC(y, m, d + 1, RESET_HOUR_PHOENIX, 0, 0, 0);
    }
    // Convert wall->real by subtracting offset
    return resetWall - offMs;
  }

  function formatCountdown(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }

  // ====== DATA MODEL ======
  function defaultStore() {
    return { version: 2, days: {}, updatedAt: Date.now() };
  }

  function loadStore() {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object") return defaultStore();
    if (!parsed.days || typeof parsed.days !== "object") parsed.days = {};
    if (!parsed.version) parsed.version = 2;
    return parsed;
  }

  function saveStore(store) {
    store.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }

  function pruneOldDays(store) {
    const keys = Object.keys(store.days).sort(); // YYYY-MM-DD sorts chronologically
    const extra = keys.length - HISTORY_DAYS_TO_KEEP;
    if (extra <= 0) return;
    for (let i = 0; i < extra; i++) delete store.days[keys[i]];
  }

  function ensureDayRecord(store, dayKey, tasks) {
    if (!store.days[dayKey]) {
      store.days[dayKey] = {
        createdAt: Date.now(),
        completed: {}, // taskId -> boolean
        notes: {},
      };
    }

    // Ensure every current task has a boolean entry
    const rec = store.days[dayKey];
    for (const t of tasks) {
      if (typeof rec.completed[t.id] !== "boolean") rec.completed[t.id] = false;
    }

    // Remove tasks that no longer exist (keeps storage clean)
    const validIds = new Set(tasks.map(t => t.id));
    for (const id of Object.keys(rec.completed)) {
      if (!validIds.has(id)) delete rec.completed[id];
    }
  }

  // ====== TASK SET ======
  function tasksForDay(dayKey) {
    const fasting = isFastingDay(dayKey);
    const tasks = fasting ? [FASTING_TASK, ...BASE_TASKS] : [...BASE_TASKS];
    return { tasks, fasting };
  }

  // ====== RENDER ======
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

  function render(dayKey, store) {
    const { tasks, fasting } = tasksForDay(dayKey);
    ensureDayRecord(store, dayKey, tasks);

    dayKeyEl.textContent = dayKey;
    fastingPillEl.style.display = fasting ? "inline-flex" : "none";

    // List
    listEl.innerHTML = "";
    const rec = store.days[dayKey];

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

      cb.addEventListener("change", () => {
        rec.completed[t.id] = cb.checked;
        saveStore(store);
        refreshProgress(dayKey, store);
        setStatus(`Saved • ${formatPhoenixNow(new Date())}`);
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

    refreshProgress(dayKey, store);
    saveStore(store);
  }

  function refreshProgress(dayKey, store) {
    const { tasks } = tasksForDay(dayKey);
    const rec = store.days[dayKey];
    const { done, total, pct } = computeProgress(tasks, rec.completed);

    doneCountEl.textContent = String(done);
    needCountEl.textContent = String(total);
    pctEl.textContent = `${pct}%`;
    barFillEl.style.width = `${pct}%`;
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  // ====== CONTROLS ======
  function markAll(dayKey, store) {
    const { tasks } = tasksForDay(dayKey);
    const rec = store.days[dayKey];
    for (const t of tasks) rec.completed[t.id] = true;
    saveStore(store);
    render(dayKey, store);
    setStatus(`Marked all • ${formatPhoenixNow(new Date())}`);
  }

  function resetDay(dayKey, store) {
    const { tasks } = tasksForDay(dayKey);
    const rec = store.days[dayKey];
    for (const t of tasks) rec.completed[t.id] = false;
    saveStore(store);
    render(dayKey, store);
    setStatus(`Reset today • ${formatPhoenixNow(new Date())}`);
  }

  // ====== CLOCK / AUTO-RESET ======
  function tick(now, store) {
    phxNowEl.textContent = formatPhoenixNow(now);

    const nextReset = nextResetRealEpoch(now);
    countdownEl.textContent = formatCountdown(nextReset - now.getTime());

    const currentKey = getDisciplineDayKey(now);
    const prevKey = store._activeDayKey;

    if (prevKey !== currentKey) {
      store._activeDayKey = currentKey;
      const { tasks } = tasksForDay(currentKey);
      ensureDayRecord(store, currentKey, tasks);
      pruneOldDays(store);
      saveStore(store);
      render(currentKey, store);
      setStatus(`New discipline day loaded • ${formatPhoenixNow(now)}`);
    }
  }

  // ====== BOOT ======
  function boot() {
    const store = loadStore();

    // Establish active dayKey immediately
    const now = new Date();
    const dayKey = getDisciplineDayKey(now);
    store._activeDayKey = dayKey;

    const { tasks } = tasksForDay(dayKey);
    ensureDayRecord(store, dayKey, tasks);
    pruneOldDays(store);
    saveStore(store);

    render(dayKey, store);
    setStatus(`Ready • Phoenix-locked reset at 2:00am`);

    btnMarkAll.addEventListener("click", () => markAll(store._activeDayKey, store));
    btnResetDay.addEventListener("click", () => {
      const ok = confirm("Reset TODAY (current discipline day) back to unchecked?");
      if (ok) resetDay(store._activeDayKey, store);
    });

    // Tick every second (cheap UI update) + ensures reset triggers quickly after 2am Phoenix
    tick(now, store);
    setInterval(() => tick(new Date(), store), 1000);
  }

  boot();
})();