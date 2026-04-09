const STORAGE_KEY = "vocalog:v1";

const SYSTEM_COLLECTION_IDS = {
  unsorted: "collection_unsorted",
  safeForLater: "collection_safe_for_later",
};

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback (not cryptographically secure; good enough for local ids).
  return `id_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function nowMs() {
  return Date.now();
}

function createDefaultState() {
  const createdAt = nowMs();
  return {
    version: 1,
    // Collections are a user-managed organizational layer (AO3-style).
    collections: [
      {
        id: SYSTEM_COLLECTION_IDS.unsorted,
        name: "Unsorted",
        createdAtMs: createdAt,
        isSystem: true,
      },
      {
        id: SYSTEM_COLLECTION_IDS.safeForLater,
        name: "Safe for later",
        createdAtMs: createdAt,
        isSystem: true,
      },
    ],
    // Imported sources (one per link import).
    items: [],
    // Listening logs (one per listening session).
    logs: [],
    // Feedback due on next load if user left mid-flow.
    feedbackDue: null, // { logId, deferred: boolean } - deferred means "don't auto-open again"
    activeSession: null, // { logId, startedAtMs }
    ui: {
      selectedItemId: null,
      lastCollectionId: SYSTEM_COLLECTION_IDS.unsorted,
    },
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return createDefaultState();
  try {
    const parsed = JSON.parse(raw);
    const state = parsed && typeof parsed === "object" ? parsed : createDefaultState();
    if (!state.version) state.version = 1;
    if (!Array.isArray(state.collections)) state.collections = [];
    // Ensure system collections exist.
    const existing = new Set(state.collections.map((c) => c.id));
    const createdAt = nowMs();
    if (!existing.has(SYSTEM_COLLECTION_IDS.unsorted)) {
      state.collections.unshift({
        id: SYSTEM_COLLECTION_IDS.unsorted,
        name: "Unsorted",
        createdAtMs: createdAt,
        isSystem: true,
      });
    }
    if (!existing.has(SYSTEM_COLLECTION_IDS.safeForLater)) {
      state.collections.push({
        id: SYSTEM_COLLECTION_IDS.safeForLater,
        name: "Safe for later",
        createdAtMs: createdAt,
        isSystem: true,
      });
    }
    if (!Array.isArray(state.items)) state.items = [];
    if (!Array.isArray(state.logs)) state.logs = [];
    if (!state.ui || typeof state.ui !== "object") state.ui = { selectedItemId: null, lastCollectionId: SYSTEM_COLLECTION_IDS.unsorted };
    if (!state.ui.lastCollectionId) state.ui.lastCollectionId = SYSTEM_COLLECTION_IDS.unsorted;
    if (!state.feedbackDue) state.feedbackDue = null;
    if (!("activeSession" in state)) state.activeSession = null;
    return state;
  } catch {
    return createDefaultState();
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getCollectionById(state, id) {
  return state.collections.find((c) => c.id === id) || null;
}

function getCollectionName(state, id) {
  const c = getCollectionById(state, id);
  return c ? c.name : "Unsorted";
}

function upsertCollection(state, { id, name }) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { ok: false, error: "Name required" };
  const found = state.collections.find((c) => c.id === id);
  if (found) {
    found.name = trimmed;
    return { ok: true, collection: found };
  }
  const createdAtMs = nowMs();
  const collection = { id, name: trimmed, createdAtMs, isSystem: false };
  state.collections.push(collection);
  return { ok: true, collection };
}

function deleteCollection(state, id) {
  const c = getCollectionById(state, id);
  if (!c || c.isSystem) return { ok: false, error: "Cannot delete system collection" };
  state.collections = state.collections.filter((x) => x.id !== id);
  // Move orphan logs/items back to Unsorted.
  const orphanIds = new Set([id]);
  state.logs.forEach((l) => {
    if (orphanIds.has(l.collectionId)) l.collectionId = SYSTEM_COLLECTION_IDS.unsorted;
  });
  return { ok: true };
}

function addItem(state, item) {
  const normalized = { ...item };
  if (!normalized.id) normalized.id = uuid();
  if (!normalized.collectionId) normalized.collectionId = SYSTEM_COLLECTION_IDS.unsorted;
  if (!normalized.createdAtMs) normalized.createdAtMs = nowMs();
  state.items.unshift(normalized);
  return normalized.id;
}

function createLog(state, log) {
  const normalized = { ...log };
  if (!normalized.id) normalized.id = uuid();
  state.logs.unshift(normalized);
  return normalized.id;
}

function getLogById(state, logId) {
  return state.logs.find((l) => l.id === logId) || null;
}

function updateLog(state, logId, patch) {
  const log = getLogById(state, logId);
  if (!log) return { ok: false, error: "Log not found" };
  Object.assign(log, patch);
  return { ok: true, log };
}

function getItemById(state, itemId) {
  return state.items.find((i) => i.id === itemId) || null;
}

function updateItem(state, itemId, patch) {
  const item = getItemById(state, itemId);
  if (!item) return { ok: false, error: "Item not found" };
  Object.assign(item, patch);
  return { ok: true, item };
}

export {
  STORAGE_KEY,
  SYSTEM_COLLECTION_IDS,
  uuid,
  createDefaultState,
  loadState,
  saveState,
  getCollectionById,
  getCollectionName,
  upsertCollection,
  deleteCollection,
  addItem,
  createLog,
  getLogById,
  updateLog,
  getItemById,
  updateItem,
};

