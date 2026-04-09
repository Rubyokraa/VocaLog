import {
  STORAGE_KEY,
  loadState,
  createDefaultState,
  saveState,
  SYSTEM_COLLECTION_IDS,
  addItem,
  createLog,
  updateLog,
  getLogById,
  getCollectionName,
  getItemById,
  updateItem,
  upsertCollection,
  deleteCollection,
  uuid,
} from "./storage.js";

import { formatHours, groupDurationMs, computeBreakdown, renderBarChart } from "./charts.js";

const el = (id) => document.getElementById(id);
const AUTH_TOKEN_KEY = "vocalog:authToken";
const AUTH_EMAIL_KEY = "vocalog:authEmail";
let backendAvailable = true;

const state = loadState();

// UI State
let timers = {
  interval: null,
};

/** True while user drags the listen progress range (avoid fighting `timeupdate`). */
let listenScrubbing = false;

let feedback = {
  isOpen: false,
  dueLogId: null,
  currentStars: 0,
  currentText: "",
};

// If the user tries to switch items while a listening session is active,
// we end the current session for rating first, then apply this pending selection.
let pendingSelectionId = null;
let activeCollectionPreviewId = null;

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

function setAuth(token, email) {
  if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
  else localStorage.removeItem(AUTH_TOKEN_KEY);
  if (email) localStorage.setItem(AUTH_EMAIL_KEY, email);
  else localStorage.removeItem(AUTH_EMAIL_KEY);
  renderCloudAuthUi();
}

function getAuthEmail() {
  return localStorage.getItem(AUTH_EMAIL_KEY) || "";
}

function setActiveTab(tabName) {
  const panels = document.querySelectorAll(".tabPanel");
  panels.forEach((p) => p.classList.add("hidden"));
  const panel = document.getElementById(`panel-${tabName}`);
  if (panel) panel.classList.remove("hidden");

  const buttons = document.querySelectorAll(".tabBtn");
  buttons.forEach((b) => {
    const name = b.getAttribute("data-tab");
    const isActive = name === tabName;
    // Remove both states first — avoids stuck underline if both modifiers were ever present.
    b.classList.remove("tabBtn--active", "tabBtn--inactive");
    b.classList.add(isActive ? "tabBtn--active" : "tabBtn--inactive");
    b.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

function ensureSystemOptions(selectEl, collections) {
  selectEl.innerHTML = "";
  const sorted = [...collections].sort((a, b) => {
    if (a.isSystem && !b.isSystem) return -1;
    if (!a.isSystem && b.isSystem) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const c of sorted) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    selectEl.appendChild(opt);
  }
}

function collectionOptionsWithAll(selectEl, collections) {
  selectEl.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All";
  selectEl.appendChild(allOpt);
  const sorted = [...collections].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  for (const c of sorted) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name;
    selectEl.appendChild(opt);
  }
}

function getActiveItem() {
  const itemId = state.ui.selectedItemId;
  if (!itemId) return null;
  return getItemById(state, itemId);
}

function formatDateShort(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDurationMs(ms) {
  const safe = Math.max(0, ms || 0);
  const totalSeconds = Math.floor(safe / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatMmSs(sec) {
  const t = Number.isFinite(sec) && sec >= 0 ? sec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function syncListenProgressUi() {
  const audio = el("audioEl");
  const progress = el("listenProgress");
  const curEl = el("listenTimeCurrent");
  const durEl = el("listenTimeDuration");
  if (!audio || !progress || !curEl || !durEl) return;

  const d = audio.duration;
  if (Number.isFinite(d) && d > 0) {
    progress.max = String(d);
    if (!listenScrubbing) progress.value = String(audio.currentTime);
    durEl.textContent = formatMmSs(d);
  } else {
    progress.max = "1";
    if (!listenScrubbing) progress.value = "0";
    durEl.textContent = "—";
  }
  curEl.textContent = formatMmSs(audio.currentTime);
}

function startTimer() {
  if (timers.interval) clearInterval(timers.interval);
  timers.interval = setInterval(() => {
    const active = state.activeSession;
    if (!active) return;
    const log = getLogById(state, active.logId);
    if (!log) return;
    el("listenTimer").textContent = formatDurationMs(getActiveElapsedMs());
  }, 250);
}

function stopTimer() {
  if (timers.interval) clearInterval(timers.interval);
  timers.interval = null;
}

function renderTop() {
  el("statusPill").textContent = state.activeSession ? "counting…" : "offline-first";
}

function renderCloudAuthUi() {
  const token = getAuthToken();
  const email = getAuthEmail();
  const loggedIn = !!token;

  el("signupBtn")?.classList.toggle("hidden", loggedIn);
  el("loginBtn")?.classList.toggle("hidden", loggedIn);
  el("logoutBtn")?.classList.toggle("hidden", !loggedIn);
  el("cloudPullBtn")?.classList.toggle("hidden", !loggedIn);
  el("cloudPushBtn")?.classList.toggle("hidden", !loggedIn);
  if (!backendAvailable) {
    el("signupBtn")?.classList.add("hidden");
    el("loginBtn")?.classList.add("hidden");
    el("logoutBtn")?.classList.add("hidden");
    el("cloudPullBtn")?.classList.add("hidden");
    el("cloudPushBtn")?.classList.add("hidden");
  }

  const pill = el("cloudStatusPill");
  if (!pill) return;
  if (!backendAvailable) {
    pill.textContent = "cloud: unavailable";
  } else {
    pill.textContent = loggedIn ? `cloud: ${email || "signed in"}` : "cloud: guest";
  }
}

function renderCollectionsSelect(preferredCollectionId) {
  const importSelect = el("importCollectionSelect");
  if (!importSelect) return;
  const previous =
    preferredCollectionId != null && preferredCollectionId !== ""
      ? preferredCollectionId
      : importSelect.value || "";
  ensureSystemOptions(importSelect, state.collections);
  const ids = new Set(state.collections.map((c) => c.id));
  importSelect.value = ids.has(previous) ? previous : SYSTEM_COLLECTION_IDS.unsorted;
}

function renderStatsCollectionSelect() {
  collectionOptionsWithAll(el("statsCollectionFilter"), state.collections);
}

function renderLogsFilters() {
  ensureSystemOptions(el("logsCollectionFilter"), state.collections);
  el("logsCollectionFilter").value = "";
  // Author filter is dynamic.
  const authorSet = new Map(); // key -> name
  state.logs.forEach((l) => {
    if (!l.authorKey) return;
    if (!authorSet.has(l.authorKey)) authorSet.set(l.authorKey, l.authorName || l.authorKey);
  });
  const options = [{ id: "", name: "All" }, ...Array.from(authorSet.entries()).map(([k, v]) => ({ id: k, name: v || k }))];
  el("logsAuthorFilter").innerHTML = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.name;
    el("logsAuthorFilter").appendChild(opt);
  }
}

function renderLibraryItems() {
  const list = el("itemsList");
  const q = (el("librarySearch").value || "").trim().toLowerCase();
  const items = [...state.items].filter((i) => {
    if (!q) return true;
    return (i.title || "").toLowerCase().includes(q) || (i.authorName || "").toLowerCase().includes(q) || (i.authorKey || "").toLowerCase().includes(q);
  });

  if (!items.length) {
    list.innerHTML = `<div class="text-sm text-neutral-500">No items yet.</div>`;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const isSelected = item.id === state.ui.selectedItemId;
      const collectionName = getCollectionName(state, item.collectionId || SYSTEM_COLLECTION_IDS.unsorted);
      const cover = "";
      const coverFallback = `<span class="text-[10px] text-neutral-500">cover</span>`;
      const tagsHtml = renderTagChips(item.tags);
      return `
        <button type="button"
          class="w-full text-left rounded-2xl border border-neutral-900 bg-neutral-900/10 p-4 hover:bg-neutral-900/25 transition ${isSelected ? "ring-1 ring-neutral-400 border-neutral-700" : ""}">
          <div class="flex items-start gap-4">
            <div class="w-14 h-14 rounded-xl border border-neutral-900 bg-black/40 overflow-hidden flex items-center justify-center">
              ${cover}
              ${coverFallback}
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium leading-snug truncate">${escapeHtml(item.title || "Untitled")}</div>
              <div class="mt-1 text-xs text-neutral-400 truncate">${escapeHtml(item.platform || "Other")} · ${escapeHtml(item.authorName || item.authorKey || "Unknown")} · <span class="text-neutral-500">${escapeHtml(collectionName)}</span></div>
              ${tagsHtml ? `<div class="mt-2 flex flex-wrap gap-2">${tagsHtml}</div>` : ""}
            </div>
            <div class="text-xs text-neutral-500 pt-1 whitespace-nowrap">${item.url ? "" : ""}</div>
          </div>
        </button>
      `;
    })
    .join("");

  list.querySelectorAll("button").forEach((btn, idx) => {
    const item = items[idx];
    btn.addEventListener("click", () => selectItem(item.id));
  });
}

function renderListenCard() {
  const card = el("listenCard");
  const empty = el("listenCardEmpty");
  const item = getActiveItem();
  const audioEl = el("audioEl");
  const playerWrap = el("listenPlayerWrap");
  const playPauseBtn = el("listenPlayPauseBtn");
  const errEl = el("listenPlaybackError");

  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }

  audioEl.pause?.();
  if (item?.audioUrl) {
    if (audioEl.dataset.loadedUrl !== item.audioUrl) {
      audioEl.dataset.loadedUrl = item.audioUrl;
      audioEl.src = item.audioUrl;
    }
    if (playerWrap) playerWrap.classList.remove("hidden");
  } else {
    delete audioEl.dataset.loadedUrl;
    audioEl.removeAttribute("src");
    if (playerWrap) playerWrap.classList.add("hidden");
  }

  if (!item) {
    card.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  card.classList.remove("hidden");

  el("listenTitle").textContent = item.title || "Untitled";
  el("listenMeta").textContent = `${item.platform || "Other"} · ${item.authorName || item.authorKey || "Unknown"} · ${getCollectionName(state, item.collectionId || SYSTEM_COLLECTION_IDS.unsorted)}`;

  const hint = el("listenSessionHint");
  if (hint) {
    hint.textContent = item.audioUrl
      ? "Session time follows playback position."
      : "No direct audio URL — session uses a clock-only timer.";
  }

  el("listenCover").classList.add("hidden");
  el("listenCoverFallback").classList.remove("hidden");

  const startBtn = el("startBtn");
  const pauseBtn = el("pauseBtn");
  const stopBtn = el("stopBtn");
  const active = state.activeSession;
  const isActive = !!(active && active.logId);
  const isPaused = !!(active && active.paused);
  const hasAudio = !!item.audioUrl;

  if (hasAudio && playPauseBtn) {
    if (!isActive) playPauseBtn.textContent = "Play";
    else if (isPaused) playPauseBtn.textContent = "Resume";
    else playPauseBtn.textContent = "Pause";
  }

  if (hasAudio) {
    startBtn.classList.add("hidden");
    pauseBtn.classList.add("hidden");
  } else {
    startBtn.classList.remove("hidden");
  }

  if (!isActive) {
    if (!hasAudio) {
      startBtn.textContent = "Start listening";
      startBtn.classList.remove("hidden");
    }
    pauseBtn.classList.add("hidden");
    stopBtn.classList.add("hidden");
    el("listenTimer").textContent = formatDurationMs(0);
  } else if (isPaused) {
    if (!hasAudio) {
      startBtn.textContent = "Resume";
      startBtn.classList.remove("hidden");
    }
    pauseBtn.classList.add("hidden");
    stopBtn.classList.remove("hidden");
    el("listenTimer").textContent = formatDurationMs(getActiveElapsedMs());
  } else {
    if (!hasAudio) {
      startBtn.classList.add("hidden");
      pauseBtn.classList.remove("hidden");
    }
    stopBtn.classList.remove("hidden");
    el("listenTimer").textContent = formatDurationMs(getActiveElapsedMs());
  }

  syncListenProgressUi();
}

function normalizeAuthorKey(name) {
  const raw = (name || "").trim().toLowerCase();
  // Keep letters/numbers/spaces/hyphens.
  const cleaned = raw
    .replace(/[\u2019'\"`]+/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.replace(/\s/g, "-");
}

function looksLikeUrl(s) {
  if (!s) return false;
  return /^https?:\/\//i.test(String(s).trim());
}

function derivePlatformFallback(url) {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();
    if (host.includes("reddit.com")) return "Reddit";
    if (host.includes("spotify.com")) return "Spotify";
    if (host.includes("patreon.com")) return "Patreon";
    if (host.includes("soundgasm.net")) return "Soundgasm";
  } catch {
    // ignore
  }
  return "Other";
}

function deriveTitleFallback({ url, platform }) {
  try {
    const u = new URL(url);
    const host = (u.hostname || "").toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean);

    if (platform === "Soundgasm" || host.includes("soundgasm.net")) {
      // /u/<author>/<slug>
      const slug = parts[2] || parts[parts.length - 1] || "";
      if (!slug) return "";

      // Turn "M4F-Showing-..." into "M4F Showing ..." first.
      let words = slug.replace(/-/g, " ").replace(/\s+/g, " ").trim();
      // Heuristic: if first token looks like a tag (M4F, M/M, F4M etc), bracket it.
      const m = words.match(/^([A-Za-z0-9]{2,5})\s+(.*)$/);
      if (m) {
        const tag = m[1];
        const rest = m[2];
        // Only bracket typical shorthand tokens (avoid over-bracketing real sentences).
        if (/^[A-Za-z0-9]{2,5}$/.test(tag)) {
          words = `[${tag}] ${rest}`;
        }
      }
      return words;
    }
  } catch {
    // ignore
  }
  return "";
}

function deriveAuthorFallback({ url, platform, title }) {
  let authorName = "";
  const safeUrl = (url || "").trim();
  try {
    const u = new URL(safeUrl);
    const hostname = (u.hostname || "").toLowerCase();
    if (!platform || platform === "Other") platform = derivePlatformFallback(safeUrl);

    if (platform === "Patreon") {
      if (title && title.includes("|")) authorName = title.split("|", 1)[0].trim();
    }
    if (platform === "Reddit") {
      const m = u.pathname.match(/\/user\/([^\/?#]+)/i);
      if (m && m[1]) authorName = m[1].replace(/_/g, " ").trim();
    }
    if (platform === "Soundgasm") {
      // /u/<author>/<slug>
      if (u.pathname.startsWith("/u/")) {
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) authorName = parts[1].replace(/_/g, " ").trim();
      }
    }
  } catch {
    // ignore invalid URL
  }
  return authorName;
}

function extractTagsFromTitle(title) {
  const t = (title || "").trim();
  if (!t) return [];

  const tags = new Set();

  // [TAG] occurrences
  const bracketRe = /\[([^\]]{1,24})\]/g;
  let m;
  while ((m = bracketRe.exec(t))) {
    const raw = (m[1] || "").trim();
    if (!raw) continue;
    // Split "[M4F] [SFW]" or "[M4F, SFW]" patterns.
    raw
      .split(/[,/|]+|\s{2,}/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => tags.add(x.toUpperCase()));
  }

  // Leading token like "M4F ..." or "F4M ..." without brackets.
  const lead = t.match(/^([A-Za-z0-9]{2,6})\b/);
  if (lead && lead[1] && /^[A-Za-z0-9]{2,6}$/.test(lead[1])) {
    const token = lead[1].toUpperCase();
    // Only accept common-ish formats to avoid tagging normal words.
    if (/^[MF]4[MF]$/.test(token) || /^[MF]\/[MF]$/.test(token) || /^A4A$/.test(token)) {
      tags.add(token);
    }
  }

  // SFW / NSFW keywords anywhere
  if (/\bNSFW\b/i.test(t)) tags.add("NSFW");
  if (/\bSFW\b/i.test(t)) tags.add("SFW");

  return Array.from(tags);
}

function renderTagChips(tags) {
  const list = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (!list.length) return "";
  return list
    .slice(0, 4)
    .map(
      (tag) =>
        `<span class="inline-flex items-center px-2 py-1 rounded-full border border-neutral-800 bg-neutral-900/20 text-[11px] text-neutral-300">${escapeHtml(tag)}</span>`,
    )
    .join(" ");
}

function selectItem(itemId) {
  // If feedback modal is open, overlay will block clicks anyway.
  // If a listening session is active, switching content should end the current session.
  if (state.activeSession) {
    pendingSelectionId = itemId;
    stopListening({ openModal: true });
    return;
  }
  state.ui.selectedItemId = itemId;
  saveState(state);
  renderLibraryItems();
  renderListenCard();
}

async function importLink() {
  const url = (el("importUrl").value || "").trim();
  if (!url) return;

  el("importStatus").textContent = "Fetching metadata…";
  el("importPreviewWrap").classList.add("hidden");
  const importCreateStatus = el("importCreateCollectionStatus");
  if (importCreateStatus) importCreateStatus.textContent = "";

  try {
    let data = null;
    try {
      const resp = await fetch(`/api/metadata?url=${encodeURIComponent(url)}`);
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error || "Failed to fetch metadata");
      data = json;
    } catch {
      // Static-host fallback (e.g. GitHub Pages): derive from URL/title heuristics only.
      data = {
        url,
        title: url,
        platform: derivePlatformFallback(url),
        authorName: "",
        authorKey: "unknown",
        audioUrl: "",
      };
      el("importStatus").textContent = "Metadata API unavailable. Using URL fallback.";
    }

    let title = data.title || url;
    let platform = data.platform || "Other";
    const coverUrl = "";
    const audioUrl = data.audioUrl || "";

    if (!platform || platform === "Other") platform = derivePlatformFallback(url);
    if (!title || looksLikeUrl(title)) {
      const derived = deriveTitleFallback({ url, platform });
      if (derived) title = derived;
    }

    let authorName = data.authorName || "";
    let authorKey = data.authorKey || "";
    if (!authorName) {
      authorName = deriveAuthorFallback({ url, platform, title });
    }
    if (!authorKey || authorKey === "unknown") {
      authorKey = authorName ? normalizeAuthorKey(authorName) : "unknown";
    }

    const tags = extractTagsFromTitle(title);

    // Render preview.
    el("importTitle").textContent = title;
    el("importMetaLine").innerHTML = `${escapeHtml(platform)} · ${escapeHtml(authorName || authorKey)}${tags.length ? ` · <span class="align-middle">${renderTagChips(tags)}</span>` : ""}`;

    el("importCover").classList.add("hidden");
    el("importCoverFallback").classList.remove("hidden");

    // Stash preview on dataset for add action.
    el("importAddBtn").dataset.preview = JSON.stringify({
      url: data.url || url,
      title,
      platform,
      coverUrl,
      audioUrl,
      authorName,
      authorKey,
      tags,
    });

    if (data.warning) el("importStatus").textContent = `Imported with warning: ${data.warning}`;
    else if (!el("importStatus").textContent) el("importStatus").textContent = "Ready.";
    el("importPreviewWrap").classList.remove("hidden");
  } catch (e) {
    el("importStatus").textContent = `Error: ${e?.message || String(e)}`;
  }
}

function addPreviewToLibrary() {
  const raw = el("importAddBtn").dataset.preview;
  if (!raw) return;

  let preview;
  try {
    preview = JSON.parse(raw);
  } catch {
    return;
  }

  const collectionId = el("importCollectionSelect").value || SYSTEM_COLLECTION_IDS.unsorted;

  const item = {
    id: uuid(),
    url: preview.url,
    title: preview.title,
    platform: preview.platform,
    coverUrl: preview.coverUrl,
    authorName: preview.authorName,
    authorKey: preview.authorKey,
    collectionId,
    createdAtMs: Date.now(),
    audioUrl: preview.audioUrl || "",
    tags: Array.isArray(preview.tags) ? preview.tags : [],
  };

  addItem(state, item);
  state.ui.selectedItemId = item.id;
  state.ui.lastCollectionId = collectionId;
  // Clear preview.
  el("importUrl").value = "";
  el("importPreviewWrap").classList.add("hidden");
  el("importStatus").textContent = "Added to library.";
  saveState(state);

  renderLibraryItems();
  renderListenCard();
}

function createLogForActiveSessionStarted() {
  const item = getActiveItem();
  if (!item) throw new Error("No item selected");

  const startedAtMs = Date.now();
  const logId = uuid();

  const log = {
    id: logId,
    itemId: item.id,
    itemTitle: item.title,
    platform: item.platform,
    coverUrl: item.coverUrl || "",
    authorName: item.authorName || "",
    authorKey: item.authorKey || "unknown",
    collectionId: item.collectionId || SYSTEM_COLLECTION_IDS.unsorted,
    collectionName: getCollectionName(state, item.collectionId || SYSTEM_COLLECTION_IDS.unsorted),
    startedAtMs,
    endedAtMs: null,
    durationMs: 0,
    durationOverrideMs: null,
    rating: null, // {stars, text, createdAtMs}
    ratingDeferred: false,
    createdAtMs: startedAtMs,
    audioUrl: item.audioUrl || "",
    tags: Array.isArray(item.tags) ? item.tags : [],
  };

  createLog(state, log);
  state.activeSession = { logId, startedAtMs, accumulatedMs: 0, paused: false };
  return logId;
}

function startListening() {
  if (state.activeSession) return;
  try {
    createLogForActiveSessionStarted();
    saveState(state);
    renderTop();
    renderListenCard();
    startTimer();
    const audioEl = el("audioEl");
    const currentItem = getActiveItem();
    if (audioEl && state.activeSession && currentItem?.audioUrl) {
      const errEl = el("listenPlaybackError");
      if (errEl) {
        errEl.classList.add("hidden");
        errEl.textContent = "";
      }
      audioEl.currentTime = 0;
      audioEl
        .play()
        .then(() => syncListenProgressUi())
        .catch((err) => {
          if (errEl) {
            errEl.textContent =
              "Playback blocked or stream unavailable (try another browser or check the site allows embedding). Timer still runs.";
            errEl.classList.remove("hidden");
          }
        });
    }
  } catch (e) {
    el("importStatus").textContent = `Start error: ${e?.message || String(e)}`;
  }
}

function getActiveElapsedMs() {
  const active = state.activeSession;
  if (!active) return 0;
  const item = getActiveItem();
  const audio = el("audioEl");
  if (item?.audioUrl && audio?.src) {
    if (active.paused) return active.accumulatedMs || 0;
    const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    return Math.floor(t * 1000);
  }
  const base = active.accumulatedMs || 0;
  if (active.startedAtMs && !active.paused) {
    return base + (Date.now() - active.startedAtMs);
  }
  return base;
}

function pauseListening() {
  const active = state.activeSession;
  if (!active || active.paused) return;
  const audioEl = el("audioEl");
  audioEl?.pause?.();

  const elapsed = getActiveElapsedMs();
  active.accumulatedMs = elapsed;
  active.startedAtMs = null;
  active.paused = true;
  saveState(state);

  stopTimer();
  renderTop();
  renderListenCard();
}

function resumeListening() {
  const active = state.activeSession;
  if (!active || !active.paused) return;
  active.startedAtMs = Date.now();
  active.paused = false;
  saveState(state);

  renderTop();
  renderListenCard();
  startTimer();

  const audioEl = el("audioEl");
  const currentItem = getActiveItem();
  if (audioEl && currentItem?.audioUrl) {
    audioEl
      .play()
      .catch(() => {
        // ignore autoplay issues
      });
  }
}

function openFeedbackModal(logId, { due = false } = {}) {
  const log = getLogById(state, logId);
  if (!log) return;

  feedback.isOpen = true;
  feedback.dueLogId = logId;
  feedback.currentStars = 0;
  feedback.currentText = "";

  el("feedbackOverlay").classList.remove("hidden");

  el("feedbackTitle").textContent = log.itemTitle || "Untitled";
  el("feedbackText").value = "";
  el("starsHint").textContent = "Pick 1–5 stars.";

  // Reset stars UI.
  el("starsRow").querySelectorAll(".starBtn").forEach((btn) => {
    btn.classList.remove("text-neutral-200");
    btn.classList.add("text-neutral-500");
  });

  // If due modal shows existing ratingDeferred true, don't auto-open.
  if (log.ratingDeferred) {
    el("starsHint").textContent = "You saved this for later. You can still review.";
  }

  // Prevent background scroll.
  document.body.style.overflow = "hidden";
}

function closeFeedbackModal() {
  feedback.isOpen = false;
  feedback.dueLogId = null;
  el("feedbackOverlay").classList.add("hidden");
  document.body.style.overflow = "";

  // Apply pending selection after rating is saved.
  if (pendingSelectionId) {
    const nextId = pendingSelectionId;
    pendingSelectionId = null;
    state.ui.selectedItemId = nextId;
    saveState(state);
    renderLibraryItems();
    renderListenCard();
  }
}

function setStarsUI(stars) {
  const btns = el("starsRow").querySelectorAll(".starBtn");
  btns.forEach((btn) => {
    const v = parseInt(btn.dataset.star, 10);
    const active = v <= stars;
    if (active) {
      btn.classList.remove("text-neutral-500");
      btn.classList.add("text-neutral-200");
    } else {
      btn.classList.remove("text-neutral-200");
      btn.classList.add("text-neutral-500");
    }
  });
}

function stopListening({ openModal = true, renderUI = true } = {}) {
  const active = state.activeSession;
  if (!active) return;

  const log = getLogById(state, active.logId);
  if (!log) return;

  const audioEl = el("audioEl");
  audioEl?.pause?.();

  const endedAtMs = Date.now();
  const durationMs = Math.max(0, getActiveElapsedMs());

  updateLog(state, log.id, {
    endedAtMs,
    durationMs,
    collectionName: getCollectionName(state, log.collectionId),
  });

  state.activeSession = null;
  state.feedbackDue = { logId: log.id, deferred: false };
  saveState(state);

  stopTimer();
  if (renderUI) {
    renderTop();
    renderListenCard();
    renderLogs();
    renderStats();
    renderCollectionsList();
  }
  if (openModal) openFeedbackModal(log.id, { due: true });
}

function saveFeedback({ deferred = false } = {}) {
  const logId = feedback.dueLogId;
  if (!logId) return;
  const log = getLogById(state, logId);
  if (!log) return;

  if (!deferred) {
    if (feedback.currentStars < 1) {
      el("starsHint").textContent = "Please select 1–5 stars.";
      return;
    }
    const text = (el("feedbackText").value || "").trim();
    updateLog(state, logId, {
      rating: {
        stars: feedback.currentStars,
        text,
        createdAtMs: Date.now(),
      },
      ratingDeferred: false,
    });
  } else {
    updateLog(state, logId, {
      rating: null,
      ratingDeferred: true,
    });
  }

  state.feedbackDue = null;
  saveState(state);

  closeFeedbackModal();
  renderLogs();
  renderStats();
}

function initFeedbackModalBindings() {
  el("feedbackOverlay").addEventListener("click", (e) => {
    // Block background clicks; modal doesn't have close.
    e.stopPropagation();
  });

  el("starsRow").querySelectorAll(".starBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const star = parseInt(btn.dataset.star, 10);
      feedback.currentStars = star;
      setStarsUI(star);
      el("starsHint").textContent = `Selected: ${star} star${star === 1 ? "" : "s"}.`;
    });
  });

  el("saveFeedbackBtn").addEventListener("click", () => {
    feedback.currentText = (el("feedbackText").value || "").trim();
    saveFeedback({ deferred: false });
  });

  el("laterFeedbackBtn").addEventListener("click", () => {
    saveFeedback({ deferred: true });
  });
}

function maybeOpenDueFeedbackOnLoad() {
  if (!state.feedbackDue || !state.feedbackDue.logId) return;
  const logId = state.feedbackDue.logId;
  const log = getLogById(state, logId);
  if (!log) return;
  const isRated = !!log.rating;
  if (isRated) {
    state.feedbackDue = null;
    saveState(state);
    return;
  }
  if (log.ratingDeferred) {
    state.feedbackDue = null;
    saveState(state);
    return;
  }
  // Open modal once on load.
  openFeedbackModal(logId, { due: true });
}

function renderLogs() {
  const list = el("logsList");
  const collectionId = el("logsCollectionFilter").value || "";
  const authorKey = el("logsAuthorFilter").value || "";

  const filtered = state.logs
    .filter((l) => !!l.endedAtMs)
    .filter((l) => (collectionId ? l.collectionId === collectionId : true))
    .filter((l) => (authorKey ? (l.authorKey || "") === authorKey : true))
    .sort((a, b) => b.endedAtMs - a.endedAtMs);

  if (!filtered.length) {
    list.innerHTML = `<div class="text-sm text-neutral-500">No logs yet.</div>`;
    return;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  function dayKey(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dayHeader(ms) {
    if (ms >= todayStart) return "Today";
    if (ms >= yesterdayStart) return "Yesterday";
    const d = new Date(ms);
    return d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
    });
  }

  const groups = [];
  const groupMap = new Map();
  for (const log of filtered) {
    const key = dayKey(log.endedAtMs);
    if (!groupMap.has(key)) {
      const g = { key, title: dayHeader(log.endedAtMs), logs: [] };
      groupMap.set(key, g);
      groups.push(g);
    }
    groupMap.get(key).logs.push(log);
  }

  list.innerHTML = groups
    .map((group) => {
      const logsHtml = group.logs
        .map((log) => {
      const cover = `<span class="text-[10px] text-neutral-500">cover</span>`;

      const ratingBlock = log.rating
        ? renderStarsInline(log.rating.stars) + (log.rating.text ? `<div class="mt-1 text-xs text-neutral-400">${escapeHtml(log.rating.text)}</div>` : "")
        : log.ratingDeferred
          ? `<div class="mt-1 text-xs text-neutral-500">Saved for later</div>
             <button type="button" class="mt-2 text-xs rounded-lg border border-neutral-600 bg-neutral-800/45 text-neutral-100 px-3 py-2 font-medium hover:bg-neutral-800/75 transition" data-rate="${log.id}">Rate now</button>`
          : `<button type="button" class="mt-2 text-xs rounded-lg border border-neutral-600 bg-neutral-800/45 text-neutral-100 px-3 py-2 font-medium hover:bg-neutral-800/75 transition" data-rate="${log.id}">Rate</button>`;

      const durationMs = log.durationOverrideMs ?? log.durationMs ?? 0;

      return `
        <div class="rounded-2xl border border-neutral-900 bg-neutral-900/10 p-4">
          <div class="flex items-start gap-4">
            <div class="w-14 h-14 rounded-xl border border-neutral-900 bg-black/40 overflow-hidden flex items-center justify-center">
              ${cover}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm font-medium leading-snug truncate">${escapeHtml(log.itemTitle || "Untitled")}</div>
                  <div class="mt-1 text-xs text-neutral-400">
                    ${escapeHtml(formatDateShort(log.endedAtMs))} · ${escapeHtml(log.platform || "Other")} · ${escapeHtml(log.authorName || log.authorKey || "Unknown")}
                  </div>
                </div>
                <div class="text-right whitespace-nowrap">
                  <div class="text-xs text-neutral-500">Duration</div>
                  <div class="text-sm font-medium">${escapeHtml(formatDurationMs(durationMs))}</div>
                </div>
              </div>

              <div class="mt-3">
                ${ratingBlock}
              </div>

              <div class="mt-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                <div class="flex-1">
                  <label class="text-[11px] text-neutral-500">Move to collection</label>
                  <select class="mt-1 w-full sm:w-72 rounded-xl border border-neutral-900 bg-black/30 px-3 py-2 text-sm outline-none focus:border-neutral-700" data-move="${log.id}">
                    ${renderCollectionOptions(log.collectionId)}
                  </select>
                </div>
                <div class="flex gap-3">
                  <button type="button" class="rounded-lg border border-neutral-800 text-neutral-500 px-3 py-1.5 text-xs font-medium hover:border-neutral-600 hover:text-neutral-300 transition" data-edit="${log.id}">
                    Edit duration
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
        })
        .join("");

      return `
        <section class="space-y-4">
          <div class="flex items-center gap-3 pt-2">
            <div class="text-sm sm:text-base font-medium text-neutral-200">${escapeHtml(group.title)}</div>
            <div class="h-px flex-1 bg-neutral-900"></div>
          </div>
          ${logsHtml}
        </section>
      `;
    })
    .join("");

  // Bind actions.
  list.querySelectorAll("[data-rate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const logId = btn.dataset.rate;
      openFeedbackModal(logId, { due: true });
    });
  });
  list.querySelectorAll("[data-move]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const logId = sel.dataset.move;
      const newCollectionId = sel.value;
      updateLog(state, logId, { collectionId: newCollectionId, collectionName: getCollectionName(state, newCollectionId) });
      saveState(state);
      renderLogs();
      renderStats();
      renderCollectionsList();
    });
  });
  list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const logId = btn.dataset.edit;
      const log = getLogById(state, logId);
      if (!log) return;
      const current = Math.floor(((log.durationOverrideMs ?? log.durationMs ?? 0) / 1000) || 0);
      const input = window.prompt("Set duration (seconds).", String(current));
      if (input === null) return;
      const seconds = parseInt(input, 10);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      updateLog(state, logId, { durationOverrideMs: seconds * 1000 });
      saveState(state);
      renderLogs();
      renderStats();
      renderCollectionsList();
    });
  });
}

function renderCollectionOptions(selectedCollectionId) {
  const options = state.collections
    .slice()
    .sort((a, b) => {
      if (a.isSystem && !b.isSystem) return -1;
      if (!a.isSystem && b.isSystem) return 1;
      return (a.name || "").localeCompare(b.name || "");
    })
    .map((c) => {
      const sel = c.id === selectedCollectionId ? "selected" : "";
      return `<option value="${escapeAttr(c.id)}" ${sel}>${escapeHtml(c.name)}</option>`;
    })
    .join("");
  return options;
}

function renderStarsInline(stars) {
  const s = Math.max(0, Math.min(5, parseInt(stars, 10) || 0));
  const filled = "★".repeat(s);
  const empty = "☆".repeat(5 - s);
  return `<div class="text-xs text-neutral-200">${escapeHtml(filled)}${escapeHtml(empty)}</div>`;
}

function renderStats() {
  const timeSeriesChart = el("timeSeriesChart");
  const breakdownChart = el("breakdownChart");

  const rangeValue = el("statsRange").value;
  const dimension = el("statsAggregate").value;
  const collectionId = el("statsCollectionFilter").value || "";

  const logsEnriched = state.logs.map((l) => ({
    ...l,
    collectionName: getCollectionName(state, l.collectionId),
  }));

  const authorKey = "";

  const series = groupDurationMs(logsEnriched, { rangeValue, collectionId: collectionId || null, authorKey: authorKey || null });
  el("statsTotal").textContent = `${formatHours(series.totalMs)}`;
  el("statsSubline").textContent = `${series.labels.length} buckets · ${collectionId ? getCollectionName(state, collectionId) : "All collections"}`;

  renderBarChart(timeSeriesChart, {
    labels: series.labels,
    values: series.values,
    rangeValue,
    valueFormatter: (v) => formatHours(v),
  });

  const breakdown = computeBreakdown(logsEnriched, { dimension, collectionId: collectionId || null, authorKey: null, rangeValue });
  const top = breakdown.slice(0, 7);
  const other = breakdown.slice(7);
  const entries = other.length ? [...top, { key: "Other", valueMs: other.reduce((a, b) => a + b.valueMs, 0) }] : top;

  const labels = entries.map((e) => (e.key || "Other").toString());
  const values = entries.map((e) => e.valueMs);

  renderBarChart(breakdownChart, {
    labels,
    values,
    rangeValue,
    valueFormatter: (v) => formatHours(v),
  });
}

function renderCollectionsList() {
  const list = el("collectionsList");
  const collections = [...state.collections].slice();

  const enriched = collections
    .map((c) => {
      const logs = state.logs.filter((l) => l.collectionId === c.id && !!l.endedAtMs);
      const totalMs = logs.reduce((acc, l) => acc + (l.durationOverrideMs ?? l.durationMs ?? 0), 0);
      return { c, count: logs.length, totalMs };
    })
    .sort((a, b) => {
      if (a.c.isSystem && !b.c.isSystem) return -1;
      if (!a.c.isSystem && b.c.isSystem) return 1;
      return b.totalMs - a.totalMs;
    });

  if (!enriched.length) {
    list.innerHTML = `<div class="text-sm text-neutral-500">No collections.</div>`;
    return;
  }

  list.innerHTML = enriched
    .map(({ c, count, totalMs }) => {
      const isSystem = c.isSystem;
      const badge = isSystem ? `<span class="text-[11px] px-2 py-1 rounded-full border border-neutral-800 text-neutral-500">system</span>` : "";
      return `
        <div class="rounded-2xl border border-neutral-900 bg-neutral-900/10 p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="flex items-center gap-2">
                <div class="text-sm font-medium">${escapeHtml(c.name)}</div>
                ${badge}
              </div>
              <div class="mt-1 text-xs text-neutral-400">${count} logs · ${formatHours(totalMs)}</div>
            </div>
            <div class="text-right">
              <button type="button" class="rounded-lg border border-neutral-600 bg-neutral-800/45 text-neutral-100 px-3 py-2 text-xs font-medium hover:bg-neutral-800/75 transition" data-open="${c.id}">Open</button>
              ${isSystem ? "" : `<button type="button" class="rounded-lg border border-neutral-800 text-neutral-500 px-3 py-2 text-xs font-medium hover:border-neutral-600 hover:text-neutral-300 transition" data-del="${c.id}">Delete</button>`}
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.del;
      const ok = window.confirm(`Delete collection "${getCollectionName(state, id)}"? Logs will move to Unsorted.`);
      if (!ok) return;
      const res = deleteCollection(state, id);
      if (!res.ok) return;
      saveState(state);
      renderCollectionsList();
      renderLogs();
      renderStats();
    });
  });

  list.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.open;
      openCollectionItemsPanel(id);
    });
  });
}

function openCollectionItemsPanel(collectionId) {
  activeCollectionPreviewId = collectionId;
  const panel = el("collectionItemsPanel");
  const title = el("collectionItemsTitle");
  const meta = el("collectionItemsMeta");
  const list = el("collectionItemsList");

  const collectionName = getCollectionName(state, collectionId);
  const items = state.items.filter((i) => i.collectionId === collectionId);

  title.textContent = collectionName;
  meta.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    list.innerHTML = `<div class="text-sm text-neutral-500">No items in this collection.</div>`;
  } else {
    list.innerHTML = items
      .map(
        (item) => `
          <div class="rounded-xl border border-neutral-900 bg-neutral-900/10 p-3">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-sm text-neutral-100 truncate">${escapeHtml(item.title || "Untitled")}</div>
                <div class="mt-1 text-xs text-neutral-400 truncate">${escapeHtml(item.platform || "Other")} · ${escapeHtml(item.authorName || item.authorKey || "Unknown")}</div>
              </div>
              <button type="button" class="rounded-lg border border-neutral-600 bg-neutral-800/45 text-neutral-100 px-3 py-2 text-xs font-medium hover:bg-neutral-800/75 transition" data-open-listen="${escapeAttr(
                item.id,
              )}">
                Open in Listen
              </button>
            </div>
          </div>
        `,
      )
      .join("");
  }

  list.querySelectorAll("[data-open-listen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const itemId = btn.dataset.openListen;
      state.ui.selectedItemId = itemId;
      saveState(state);
      setActiveTab("library");
      renderLibraryItems();
      renderListenCard();
    });
  });

  panel.classList.remove("hidden");
}

function initListenPlayerEvents() {
  const progress = el("listenProgress");
  const audio = el("audioEl");
  if (!progress || !audio || audio.dataset.vocaListenBound) return;
  audio.dataset.vocaListenBound = "1";

  progress.addEventListener("pointerdown", () => {
    listenScrubbing = true;
  });
  progress.addEventListener("pointerup", () => {
    listenScrubbing = false;
    syncListenProgressUi();
  });
  progress.addEventListener("pointercancel", () => {
    listenScrubbing = false;
  });
  progress.addEventListener("input", () => {
    const max = parseFloat(progress.max);
    const v = parseFloat(progress.value);
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(v)) return;
    try {
      audio.currentTime = Math.min(max, Math.max(0, v));
    } catch {
      // seek may fail before metadata
    }
    syncListenProgressUi();
  });

  audio.addEventListener("loadedmetadata", () => syncListenProgressUi());
  audio.addEventListener("timeupdate", () => {
    syncListenProgressUi();
    if (state.activeSession) {
      const t = el("listenTimer");
      if (t) t.textContent = formatDurationMs(getActiveElapsedMs());
    }
  });
  audio.addEventListener("error", () => {
    const errEl = el("listenPlaybackError");
    const item = getActiveItem();
    if (errEl && item?.audioUrl) {
      errEl.textContent = "Could not load this audio URL (network, CORS, or expired link).";
      errEl.classList.remove("hidden");
    }
  });
}

function bindUI() {
  // Tabs
  document.querySelectorAll(".tabBtn").forEach((b) => {
    b.addEventListener("click", () => {
      const tab = b.getAttribute("data-tab");
      if (!tab) return;
      setActiveTab(tab);
      if (tab === "logs") renderLogs();
      if (tab === "stats") renderStats();
      if (tab === "collections") renderCollectionsList();
    });
  });

  el("listenPlayPauseBtn")?.addEventListener("click", () => {
    const item = getActiveItem();
    if (!item?.audioUrl) return;
    if (!state.activeSession) {
      startListening();
      return;
    }
    if (state.activeSession.paused) resumeListening();
    else pauseListening();
  });

  // Import
  el("importBtn")?.addEventListener("click", importLink);
  el("importUrl")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") importLink();
  });
  el("importAddBtn")?.addEventListener("click", addPreviewToLibrary);

  el("importCreateCollectionBtn")?.addEventListener("click", () => {
    const name = (el("importNewCollectionName")?.value || "").trim();
    const statusEl = el("importCreateCollectionStatus");
    if (statusEl) statusEl.textContent = "";
    if (!name) {
      if (statusEl) statusEl.textContent = "Enter a name.";
      return;
    }
    const id = `collection_${uuid().slice(0, 10)}`;
    const res = upsertCollection(state, { id, name });
    if (!res.ok) {
      if (statusEl) statusEl.textContent = res.error || "Failed";
      return;
    }
    el("importNewCollectionName").value = "";
    if (statusEl) statusEl.textContent = "Created and selected.";
    saveState(state);
    renderCollectionsSelect(id);
    renderLogsFilters();
    renderStatsCollectionSelect();
    renderCollectionsList();
    el("importStatus").textContent = `Collection “${name}” ready — add to library when you’re set.`;
  });

  el("importNewCollectionName")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el("importCreateCollectionBtn")?.click();
  });

  // Library search
  el("librarySearch")?.addEventListener("input", () => renderLibraryItems());

  // Listening
  el("startBtn")?.addEventListener("click", () => {
    if (state.activeSession && state.activeSession.paused) {
      resumeListening();
    } else {
      startListening();
    }
  });
  el("pauseBtn")?.addEventListener("click", pauseListening);
  el("stopBtn")?.addEventListener("click", stopListening);

  // Filters
  el("logsCollectionFilter")?.addEventListener("change", renderLogs);
  el("logsAuthorFilter")?.addEventListener("change", renderLogs);

  // Stats controls
  el("statsRange")?.addEventListener("change", renderStats);
  el("statsAggregate")?.addEventListener("change", renderStats);
  el("statsCollectionFilter")?.addEventListener("change", renderStats);

  // Collections create
  el("createCollectionBtn")?.addEventListener("click", () => {
    const name = el("newCollectionName").value || "";
    const id = `collection_${uuid().slice(0, 10)}`;
    const res = upsertCollection(state, { id, name });
    if (!res.ok) {
      el("createCollectionStatus").textContent = res.error || "Failed";
      return;
    }
    el("newCollectionName").value = "";
    el("createCollectionStatus").textContent = "Created.";
    saveState(state);
    renderCollectionsSelect();
    renderLogsFilters();
    renderStatsCollectionSelect();
    renderCollectionsList();
    renderLogs();
    renderStats();
  });

  // Backup export/import
  el("exportBackupBtn")?.addEventListener("click", () => {
    exportBackup();
  });
  el("importBackupBtn")?.addEventListener("click", () => {
    el("importBackupInput")?.click();
  });
  el("importBackupInput")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    importBackupFile(file);
    // reset input so selecting same file again still triggers change
    e.target.value = "";
  });

  // Cloud auth/sync
  el("signupBtn")?.addEventListener("click", signupFlow);
  el("loginBtn")?.addEventListener("click", loginFlow);
  el("logoutBtn")?.addEventListener("click", logoutFlow);
  el("cloudPushBtn")?.addEventListener("click", cloudPushFlow);
  el("cloudPullBtn")?.addEventListener("click", cloudPullFlow);

  el("collectionItemsCloseBtn")?.addEventListener("click", () => {
    activeCollectionPreviewId = null;
    el("collectionItemsPanel").classList.add("hidden");
  });
}

function exportBackup() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || JSON.stringify(state);
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `vocalog-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    el("importStatus").textContent = "Backup exported.";
  } catch (err) {
    el("importStatus").textContent = `Export failed: ${err?.message || String(err)}`;
  }
}

function normalizeImportedState(parsed) {
  const base = createDefaultState();
  if (!parsed || typeof parsed !== "object") return base;
  const out = { ...base, ...parsed };
  if (!Array.isArray(out.collections)) out.collections = base.collections;
  if (!Array.isArray(out.items)) out.items = [];
  if (!Array.isArray(out.logs)) out.logs = [];
  if (!out.ui || typeof out.ui !== "object") out.ui = base.ui;
  if (!("activeSession" in out)) out.activeSession = null;
  if (!("feedbackDue" in out)) out.feedbackDue = null;
  if (!out.version) out.version = 1;
  return out;
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result || "");
      const parsed = JSON.parse(text);
      const normalized = normalizeImportedState(parsed);

      // keep same reference object used across app
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, normalized);
      saveState(state);

      // refresh all views
      renderCollectionsSelect();
      renderStatsCollectionSelect();
      renderLogsFilters();
      renderCollectionsList();
      renderLibraryItems();
      renderListenCard();
      renderLogs();
      renderStats();
      renderTop();

      if (state.activeSession && state.activeSession.logId && !state.activeSession.paused) {
        startTimer();
      } else {
        stopTimer();
      }

      el("importStatus").textContent = "Backup imported successfully.";
    } catch (err) {
      el("importStatus").textContent = `Import failed: ${err?.message || String(err)}`;
    }
  };
  reader.readAsText(file, "utf-8");
}

async function apiRequest(path, { method = "GET", body = null, auth = true } = {}) {
  if (!backendAvailable) throw new Error("Backend unavailable");
  const headers = { "Content-Type": "application/json" };
  if (auth && getAuthToken()) headers.Authorization = `Bearer ${getAuthToken()}`;
  const resp = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data;
}

async function signupFlow() {
  const email = window.prompt("Sign up email:");
  if (!email) return;
  const password = window.prompt("Create password (at least 8 chars):");
  if (!password) return;
  try {
    const data = await apiRequest("/api/auth/signup", {
      method: "POST",
      auth: false,
      body: { email, password },
    });
    setAuth(data.token, data.user?.email || email);
    el("importStatus").textContent = "Signed up and logged in.";
  } catch (err) {
    el("importStatus").textContent = `Sign up failed: ${err?.message || String(err)}`;
  }
}

async function loginFlow() {
  const email = window.prompt("Login email:");
  if (!email) return;
  const password = window.prompt("Password:");
  if (!password) return;
  try {
    const data = await apiRequest("/api/auth/login", {
      method: "POST",
      auth: false,
      body: { email, password },
    });
    setAuth(data.token, data.user?.email || email);
    el("importStatus").textContent = "Logged in.";
  } catch (err) {
    el("importStatus").textContent = `Login failed: ${err?.message || String(err)}`;
  }
}

async function logoutFlow() {
  try {
    await apiRequest("/api/auth/logout", { method: "POST", auth: true });
  } catch {
    // ignore network/auth errors on logout
  }
  setAuth("", "");
  el("importStatus").textContent = "Logged out.";
}

async function cloudPushFlow() {
  try {
    await apiRequest("/api/sync/push", {
      method: "POST",
      auth: true,
      body: { state },
    });
    el("importStatus").textContent = "Cloud push success.";
  } catch (err) {
    el("importStatus").textContent = `Cloud push failed: ${err?.message || String(err)}`;
  }
}

async function cloudPullFlow() {
  try {
    const data = await apiRequest("/api/sync/pull", { method: "GET", auth: true });
    if (!data || !data.state) {
      el("importStatus").textContent = "Cloud has no saved state yet.";
      return;
    }
    const normalized = normalizeImportedState(data.state);
    Object.keys(state).forEach((k) => delete state[k]);
    Object.assign(state, normalized);
    saveState(state);

    renderCollectionsSelect();
    renderStatsCollectionSelect();
    renderLogsFilters();
    renderCollectionsList();
    renderLibraryItems();
    renderListenCard();
    renderLogs();
    renderStats();
    renderTop();
    renderCloudAuthUi();
    if (state.activeSession && state.activeSession.logId && !state.activeSession.paused) startTimer();
    else stopTimer();

    el("importStatus").textContent = "Cloud pull success.";
  } catch (err) {
    el("importStatus").textContent = `Cloud pull failed: ${err?.message || String(err)}`;
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(str) {
  return escapeHtml(str).replaceAll("\n", " ");
}

function hydrateInitialUI() {
  // Tabs default
  setActiveTab("import");

  renderCollectionsSelect();
  renderStatsCollectionSelect();
  renderLogsFilters();
  renderCollectionsList();
  renderLibraryItems();
  renderListenCard();
  renderLogs();
  renderStats();
  renderTop();
  renderCloudAuthUi();

  // If the user refreshed while a listening session is still active, resume the timer display.
  if (state.activeSession && state.activeSession.logId) {
    const log = getLogById(state, state.activeSession.logId);
    if (log && !log.endedAtMs && !state.activeSession.paused) startTimer();
  }

  // Feedback due modal
  maybeOpenDueFeedbackOnLoad();
  detectBackendAvailability();
}

async function detectBackendAvailability() {
  try {
    // Any /api endpoint existence is enough.
    const r = await fetch("/api/auth/me", { method: "GET" });
    backendAvailable = r.status !== 404;
  } catch {
    backendAvailable = false;
  }
  renderCloudAuthUi();
}

initFeedbackModalBindings();
initListenPlayerEvents();
bindUI();
hydrateInitialUI();

// When audio ends by itself, end the listening session too.
el("audioEl").addEventListener("ended", () => {
  if (!state.activeSession) return;
  stopListening();
});

// Leaving the tab while a session is active should finalize the session too.
// We don't try to render a modal in the background; the next load will open it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  if (!state.activeSession) return;
  stopListening({ openModal: false, renderUI: false });
});

window.addEventListener("pagehide", () => {
  // If the user closes the page while a session is active, finalize it silently
  // and defer rating to next load.
  if (state.activeSession) {
    stopListening({ openModal: false, renderUI: false });
  }
  if (state.feedbackDue && state.feedbackDue.logId) saveState(state);
});

