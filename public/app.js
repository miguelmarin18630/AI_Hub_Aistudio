"use strict";

const $ = (id) => document.getElementById(id);
const DEFAULT_GROUPS = [
  { id: "code", label: "Programación", short_label: "Código", icon: "⌘" },
  { id: "reasoning", label: "Razonamiento", short_label: "Razona", icon: "◈" },
  { id: "vision", label: "Visión y multimodal", short_label: "Visión", icon: "◉" },
  { id: "chat", label: "Chat y texto", short_label: "Chat", icon: "✦" },
  { id: "image", label: "Imagen", short_label: "Imagen", icon: "◫" },
  { id: "video", label: "Vídeo", short_label: "Vídeo", icon: "▶" },
];

const state = {
  user: null,
  baseProviders: [],
  presets: [],
  providers: [],
  groups: DEFAULT_GROUPS,
  models: [],
  projects: [],
  settings: null,
  vault: null,
  vaultHandle: null,
  vaultFileName: "",
  vaultDiskSynced: false,
  vaultServerSynced: false,
  vaultSyncTimer: null,
  quotaCache: new Map(),
  vaultLegacyOnServer: false,
  pendingBootstrapPack: null,
  group: "all",
  providerFilter: null,
  search: "",
  filter: "all",
  sort: "price-asc",
  autoSwitchFree: true,
  collapsedProviders: new Set(),
  collapsedGroups: new Set(),
  selected: null,
  project: "",
  messages: [],
  history: [],
  conversationId: null,
  busy: false,
  generating: false,
  controller: null,
  filePath: "",
  mobile: false,
  pwaPrompt: null,
  pwaInstalled: false,
  pwaIOS: false,
};

/* ------------------------------------------------------------------ almacén local en disco duro */

const VAULT_DB_NAME = "aihub-local-vault";
const VAULT_DB_VERSION = 1;
const VAULT_STORE = "vaults";
const HANDLE_STORE = "handles";

function defaultVault() {
  return {
    version: 1,
    updated_at: Date.now(),
    migrated_from_server: false,
    openrouter_api_key: "",
    custom_providers: [],
    models_by_provider: {},
    favorite_models: [],
    usage: {},
    history: { items: [], current: null },
    prefs: { group: "all", sort: "price-asc", filter: "all", provider: null, selected_model: "", auto_switch_free: true },
  };
}

function normalizeVault(raw) {
  const base = defaultVault();
  if (!raw || typeof raw !== "object") return base;
  if (typeof raw.openrouter_api_key === "string") base.openrouter_api_key = raw.openrouter_api_key;
  if (Array.isArray(raw.custom_providers)) {
    base.custom_providers = raw.custom_providers
      .filter((item) => item && typeof item === "object" && item.id && item.base)
      .map((item) => ({
        id: String(item.id),
        name: String(item.name || item.id),
        base: String(item.base).trim().replace(/\/+$/, ""),
        key: String(item.key || ""),
        glyph: String(item.glyph || "◆"),
        color: String(item.color || "#9aa4b2"),
        categories: Array.isArray(item.categories) && item.categories.length ? item.categories : ["code"],
      }));
  }
  if (raw.models_by_provider && typeof raw.models_by_provider === "object" && !Array.isArray(raw.models_by_provider)) {
    base.models_by_provider = raw.models_by_provider;
  }
  if (Array.isArray(raw.favorite_models)) {
    base.favorite_models = raw.favorite_models.filter((x) => typeof x === "string");
  }
  if (raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage)) {
    base.usage = raw.usage;
  }
  if (raw.history && typeof raw.history === "object") {
    base.history = {
      items: Array.isArray(raw.history.items) ? raw.history.items.slice(0, 50) : [],
      current:
        raw.history.current &&
        typeof raw.history.current === "object" &&
        Array.isArray(raw.history.current.messages) &&
        raw.history.current.messages.length
          ? raw.history.current
          : null,
    };
  }
  if (raw.prefs && typeof raw.prefs === "object") {
    base.prefs = { ...base.prefs, ...raw.prefs };
  }
  base.migrated_from_server = Boolean(raw.migrated_from_server);
  base.updated_at = Number(raw.updated_at || Date.now());

  // Migrar clave legada openrouter_api_key a proveedor añadido en custom_providers
  const legacyOrKey = String(base.openrouter_api_key || "").trim();
  if (legacyOrKey) {
    const existingOr = base.custom_providers.find((p) =>
      String(p.base || "").toLowerCase().includes("openrouter.ai")
    );
    if (existingOr) {
      if (!existingOr.key) existingOr.key = legacyOrKey;
    } else {
      const migratedId = "custom_openrouter";
      base.custom_providers.unshift({
        id: migratedId,
        name: "OpenRouter",
        base: "https://openrouter.ai/api/v1",
        key: legacyOrKey,
        glyph: "↗",
        color: "#f2b84b",
        categories: ["code", "media"],
      });
      if (Array.isArray(base.models_by_provider.openrouter) && !base.models_by_provider[migratedId]) {
        base.models_by_provider[migratedId] = base.models_by_provider.openrouter.map((m) => ({
          ...m,
          provider: migratedId,
        }));
      }
    }
    base.openrouter_api_key = "";
  }
  return base;
}

function vaultHasUserData(vault) {
  if (!vault) return false;
  return Boolean(
    vault.openrouter_api_key ||
      (vault.custom_providers && vault.custom_providers.length) ||
      (vault.favorite_models && vault.favorite_models.length) ||
      (vault.usage && Object.keys(vault.usage).length) ||
      (vault.history && vault.history.items && vault.history.items.length) ||
      (vault.history && vault.history.current && vault.history.current.messages && vault.history.current.messages.length)
  );
}

function openVaultDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB no disponible"));
      return;
    }
    const req = indexedDB.open(VAULT_DB_NAME, VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) db.createObjectStore(VAULT_STORE);
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("No se pudo abrir IndexedDB"));
  });
}

async function idbGet(storeName, key) {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(storeName, key, value) {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openVaultDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const supportsDiskFileSync = () =>
  typeof window !== "undefined" &&
  typeof window.showSaveFilePicker === "function" &&
  typeof window.showOpenFilePicker === "function";

async function writeVaultToDiskHandle(handle, vault, requestPerm = false) {
  if (!handle) return false;
  try {
    let perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && requestPerm) {
      perm = await handle.requestPermission({ mode: "readwrite" });
    }
    if (perm !== "granted") {
      state.vaultDiskSynced = false;
      return false;
    }
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(vault, null, 2));
    await writable.close();
    state.vaultDiskSynced = true;
    return true;
  } catch {
    state.vaultDiskSynced = false;
    return false;
  }
}

async function pushVaultToServerNow() {
  if (!state.user || !state.vault) return false;
  try {
    await api("/api/vault/sync", { method: "POST", body: { vault: state.vault } });
    state.vaultServerSynced = true;
    return true;
  } catch {
    state.vaultServerSynced = false;
    return false;
  }
}

function scheduleServerVaultSync() {
  if (!state.user || !state.vault) return;
  if (state.vaultSyncTimer) clearTimeout(state.vaultSyncTimer);
  state.vaultSyncTimer = setTimeout(() => {
    state.vaultSyncTimer = null;
    pushVaultToServerNow();
  }, 450);
}

async function syncVaultWithServer(forcePull = false) {
  if (!state.user || !state.vault) return "none";
  try {
    const res = await api("/api/vault/sync");
    const localHas = vaultHasUserData(state.vault);
    const localTs = Number(state.vault.updated_at || 0);
    if (res && res.has_vault && res.vault) {
      const remote = normalizeVault(res.vault);
      const remoteHas = vaultHasUserData(remote);
      const remoteTs = Number(remote.updated_at || res.updated_at || 0);
      if (remoteHas && (forcePull || !localHas || remoteTs > localTs)) {
        state.vault = remote;
        try {
          await idbSet(VAULT_STORE, state.user.id, state.vault);
        } catch {
          try {
            localStorage.setItem(`aihub.vault.fallback.${state.user.id}`, JSON.stringify(state.vault));
          } catch {
            /* ignore */
          }
        }
        state.vaultServerSynced = true;
        return "pulled";
      }
      if (localHas && localTs > remoteTs) {
        const ok = await pushVaultToServerNow();
        return ok ? "pushed" : "none";
      }
      state.vaultServerSynced = true;
      return "same";
    }
    if (localHas) {
      const ok = await pushVaultToServerNow();
      return ok ? "pushed" : "none";
    }
    return "none";
  } catch {
    return "none";
  }
}

async function loadUserVault(userId) {
  let raw = null;
  try {
    raw = await idbGet(VAULT_STORE, userId);
  } catch {
    try {
      raw = JSON.parse(localStorage.getItem(`aihub.vault.fallback.${userId}`) || "null");
    } catch {
      raw = null;
    }
  }
  state.vault = normalizeVault(raw);
  state.vaultHandle = null;
  state.vaultFileName = "";
  state.vaultDiskSynced = false;
  state.vaultServerSynced = false;
  try {
    const handle = await idbGet(HANDLE_STORE, userId);
    if (handle) {
      state.vaultHandle = handle;
      state.vaultFileName = handle.name || "aihub-datos.json";
      const perm = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
      state.vaultDiskSynced = perm === "granted";
    }
  } catch {
    /* ignore */
  }
  await syncVaultWithServer(false);
  return state.vault;
}

async function saveUserVault(skipServerSync = false) {
  if (!state.user || !state.vault) return;
  const userId = state.user.id;
  state.vault.updated_at = Date.now();
  try {
    await idbSet(VAULT_STORE, userId, state.vault);
  } catch {
    try {
      localStorage.setItem(`aihub.vault.fallback.${userId}`, JSON.stringify(state.vault));
    } catch {
      /* ignore quota */
    }
  }
  if (state.vaultHandle) {
    await writeVaultToDiskHandle(state.vaultHandle, state.vault, false);
  }
  if (!skipServerSync) {
    scheduleServerVaultSync();
  }
}

async function maybeMigrateLegacyVault() {
  if (!state.user || !state.vault) return;
  try {
    const legacy = await api("/api/vault/legacy");
    state.vaultLegacyOnServer = Boolean(legacy && legacy.has_data);
    if (!state.vaultLegacyOnServer) return;
    if (state.vault.migrated_from_server || vaultHasUserData(state.vault)) return;
    const d = legacy.data || {};
    state.vault.openrouter_api_key = String(d.openrouter_api_key || "");
    if (Array.isArray(d.custom_providers)) state.vault.custom_providers = d.custom_providers;
    if (Array.isArray(d.favorite_models)) state.vault.favorite_models = d.favorite_models;
    if (d.usage && typeof d.usage === "object") state.vault.usage = d.usage;
    if (d.history && typeof d.history === "object") {
      state.vault.history = {
        items: Array.isArray(d.history.items) ? d.history.items : [],
        current: d.history.current || null,
      };
    }
    state.vault.migrated_from_server = true;
    state.vault = normalizeVault(state.vault);
    await saveUserVault();
    toast("Tus proveedores, claves e historial anteriores se han guardado en tu disco duro local.", "ok");
  } catch {
    /* server legacy check optional */
  }
}

async function linkHardDriveFile() {
  if (!supportsDiskFileSync()) {
    toast("Tu navegador no soporta sincronización directa de archivo. Usa «Exportar copia (.json)».", "error");
    return false;
  }
  try {
    const suggested = `aihub-datos-${state.user ? state.user.id : "usuario"}.json`;
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      types: [{ description: "Datos de AI Hub (JSON)", accept: { "application/json": [".json"] } }],
    });
    const ok = await writeVaultToDiskHandle(handle, state.vault, true);
    if (!ok) throw new Error("No se obtuvo permiso de escritura en el archivo.");
    state.vaultHandle = handle;
    state.vaultFileName = handle.name || suggested;
    await idbSet(HANDLE_STORE, state.user.id, handle).catch(() => {});
    toast(`Archivo vinculado y sincronizado: ${state.vaultFileName}`, "ok");
    return true;
  } catch (exc) {
    if (exc && exc.name === "AbortError") return false;
    toast((exc && exc.message) || "No se pudo vincular el archivo.", "error");
    return false;
  }
}

async function applyImportedVaultObject(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("El archivo JSON no tiene un formato válido de AI Hub.");
  }
  const prevCache = (state.vault && state.vault.models_by_provider) || {};
  // Support both full vault export and legacy config.json / conversations.json
  const imported = normalizeVault(parsed);
  if (Array.isArray(parsed.items) && !parsed.history) {
    imported.history = {
      items: parsed.items,
      current: parsed.current || null,
    };
  }
  const hasImportedCache = Object.keys(imported.models_by_provider || {}).length > 0;
  if (!hasImportedCache && Object.keys(prevCache).length > 0) {
    imported.models_by_provider = { ...prevCache };
  }
  imported.migrated_from_server = true;
  state.vault = imported;
  await saveUserVault();
  syncStateFromVault();
  renderProviders();
  renderModels();
  renderDetail();
  if (state.vault.history.current && state.vault.history.current.messages?.length) {
    applyConversation(state.vault.history.current);
  } else {
    state.messages = [];
    state.conversationId = null;
    renderMessages();
  }
  const needsRefresh =
    !hasImportedCache &&
    ((imported.custom_providers && imported.custom_providers.length > 0) || Boolean(imported.openrouter_api_key));
  if (needsRefresh) {
    await refreshCatalog(true);
  }
}

async function openHardDriveFile() {
  if (supportsDiskFileSync()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "Datos de AI Hub (JSON)", accept: { "application/json": [".json"] } }],
      });
      const file = await handle.getFile();
      const parsed = JSON.parse(await file.text());
      await applyImportedVaultObject(parsed);
      state.vaultHandle = handle;
      state.vaultFileName = handle.name || file.name;
      await writeVaultToDiskHandle(handle, state.vault, true);
      await idbSet(HANDLE_STORE, state.user.id, handle).catch(() => {});
      toast(`Datos cargados y sincronizados con ${state.vaultFileName}`, "ok");
      return true;
    } catch (exc) {
      if (exc && exc.name === "AbortError") return false;
      toast((exc && exc.message) || "No se pudo abrir el archivo.", "error");
      return false;
    }
  }
  return triggerJsonImportInput();
}

function triggerJsonImportInput() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(false); return; }
      try {
        const parsed = JSON.parse(await file.text());
        await applyImportedVaultObject(parsed);
        toast(`Datos importados desde ${file.name}.`, "ok");
        resolve(true);
      } catch (exc) {
        toast((exc && exc.message) || "Archivo JSON no válido.", "error");
        resolve(false);
      }
    };
    input.click();
  });
}

function exportVaultBackup() {
  if (!state.vault) return;
  const filename = `aihub-datos-${state.user ? state.user.id : "usuario"}.json`;
  const blob = new Blob([JSON.stringify(state.vault, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Copia guardada en tu equipo: ${filename}`, "ok");
}

function getClientAuth(providerId) {
  if (!state.vault) return null;
  const rec = (state.vault.custom_providers || []).find((p) => p.id === providerId);
  if (rec) {
    return { api_key: String(rec.key || "").trim(), base: String(rec.base || "").trim() };
  }
  if (providerId === "openrouter") {
    const key = String(state.vault.openrouter_api_key || "").trim();
    return key ? { api_key: key, base: "https://openrouter.ai/api/v1" } : null;
  }
  return null;
}

function uniqueCustomProviderId(presetId) {
  const taken = new Set([
    ...(state.baseProviders || []).map((p) => p.id),
    ...((state.vault && state.vault.custom_providers) || []).map((p) => p.id),
  ]);
  const clean = String(presetId || "custom").toLowerCase().replace(/[^a-z0-9]+/g, "") || "custom";
  let pid = `custom_${clean}`;
  let idx = 2;
  while (taken.has(pid)) {
    pid = `custom_${clean}_${idx}`;
    idx += 1;
  }
  return pid;
}

function customProviderToEntry(record) {
  let host = record.base;
  try { host = new URL(record.base).host || record.base; } catch { /* ignore */ }
  return {
    id: record.id,
    name: record.name,
    sub: host,
    glyph: record.glyph || "◆",
    color: record.color || "#9aa4b2",
    categories: Array.isArray(record.categories) && record.categories.length ? record.categories : ["code"],
    custom: true,
  };
}

function syncStateFromVault() {
  if (!state.vault) return;
  const customEntries = (state.vault.custom_providers || []).map(customProviderToEntry);
  state.providers = [...(state.baseProviders || []), ...customEntries];
  const activeIds = new Set(state.providers.map((p) => p.id));
  const models = [];
  const cache = state.vault.models_by_provider || {};
  for (const pid of Object.keys(cache)) {
    if (!activeIds.has(pid)) continue;
    const list = Array.isArray(cache[pid]) ? cache[pid] : [];
    for (const m of list) models.push(m);
  }
  state.models = models;
  state.favorites = [...(state.vault.favorite_models || [])];
  state.history = (state.vault.history && state.vault.history.items) || [];
}

function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyUsageBucket() {
  return { requests: 0, prompt: 0, completion: 0, cost: 0, images: 0, videos: 0 };
}

function getLocalUsage(provider, uid) {
  const key = `${provider}:${uid}`;
  const raw = (state.vault && state.vault.usage && state.vault.usage[key]) || {};
  const today = todayIsoDate();
  const todayBucket = raw.date === today && raw.today ? { ...emptyUsageBucket(), ...raw.today } : emptyUsageBucket();
  return { ...emptyUsageBucket(), ...raw, date: today, today: todayBucket };
}

function recordLocalUsage(provider, uid, delta) {
  if (!state.vault) return;
  const key = `${provider}:${uid}`;
  const stats = getLocalUsage(provider, uid);
  const reqInc = delta.requests != null ? Number(delta.requests) : 1;
  const promptInc = Number(delta.prompt || delta.prompt_tokens || 0);
  const compInc = Number(delta.completion || delta.completion_tokens || 0);
  const costInc = Number(delta.cost || 0);
  const imgInc = Number(delta.images || 0);
  const vidInc = Number(delta.videos || 0);
  for (const bucket of [stats, stats.today]) {
    bucket.requests = (bucket.requests || 0) + reqInc;
    bucket.prompt = (bucket.prompt || 0) + promptInc;
    bucket.completion = (bucket.completion || 0) + compInc;
    bucket.cost = Number(((bucket.cost || 0) + costInc).toFixed(8));
    bucket.images = (bucket.images || 0) + imgInc;
    bucket.videos = (bucket.videos || 0) + vidInc;
  }
  state.vault.usage[key] = stats;
  saveUserVault();
  return stats;
}

function describeLocalUsage(stats) {
  if (!stats || !stats.requests) return "Sin consumo todavía.";
  const parts = [`${stats.requests} petición${stats.requests === 1 ? "" : "es"}`];
  const tokens = (stats.prompt || 0) + (stats.completion || 0);
  if (tokens) parts.push(`${fmtTokens(tokens)} tokens`);
  if (stats.images) parts.push(`${stats.images} imagen${stats.images === 1 ? "" : "es"}`);
  if (stats.videos) parts.push(`${stats.videos} vídeo${stats.videos === 1 ? "" : "s"}`);
  if (stats.cost) parts.push(`$${Number(stats.cost).toFixed(4)}`);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ util */

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  if (bytes >= 1024) return Math.round(bytes / 1024) + " KB";
  return bytes + " B";
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((part) => part && typeof part === "object" && part.text)
      .map((part) => String(part.text))
      .join("\n");
  }
  return value == null ? "" : String(value);
}

function fmtWhen(stamp) {
  const value = Number(stamp || 0) * 1000;
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function fmtTokens(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(".", ",") + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "K";
  if (n >= 1000) return (n / 1000).toFixed(1).replace(".", ",") + "K";
  return String(n);
}

const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
const isNarrow = () => window.matchMedia("(max-width: 1100px)").matches;

function toast(message, kind = "") {
  const root = $("toast-root");
  const item = document.createElement("div");
  item.className = "toast " + kind;
  item.textContent = message;
  root.appendChild(item);
  setTimeout(() => item.remove(), 5000);
}

function showLoading(text) {
  closeModal();
  const root = $("modal-root");
  root.innerHTML = `
    <div class="loading-overlay">
      <div class="loading-card"><span class="spinner"></span><span>${esc(text)}</span></div>
    </div>`;
}

function hideLoading() {
  const overlay = document.querySelector(".loading-overlay");
  if (overlay) overlay.remove();
}

function openModal(html, name = "") {
  const root = $("modal-root");
  const attr = name ? ` data-modal="${esc(name)}"` : "";
  root.innerHTML = `<div class="modal-overlay"${attr}><div class="modal">${html}</div></div>`;
  const overlay = root.querySelector(".modal-overlay");
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) closeModal();
  });
  root.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", closeModal);
  });
}

function closeModal() {
  $("modal-root").innerHTML = "";
}

function activeModalName() {
  const overlay = $("modal-root").querySelector(".modal-overlay");
  return overlay ? (overlay.dataset.modal || "generic") : "";
}

function isEditableTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

const isMacPlatform = () => /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");

function confirmModal(title, message, confirmLabel = "Confirmar", danger = false) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "85";
    overlay.innerHTML = `
      <div class="modal dialog-modal">
        <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-dialog-cancel>✕</button></div>
        <p class="dialog-message">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn ghost" data-dialog-cancel>Cancelar</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-dialog-ok>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const finish = (val) => {
      overlay.remove();
      resolve(val);
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelectorAll("[data-dialog-cancel]").forEach((b) => b.addEventListener("click", () => finish(false)));
    overlay.querySelector("[data-dialog-ok]").addEventListener("click", () => finish(true));
    document.body.appendChild(overlay);
    overlay.querySelector("[data-dialog-ok]").focus();
  });
}

function promptModal(title, message, defaultValue = "", inputType = "text", placeholder = "") {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "85";
    overlay.innerHTML = `
      <div class="modal dialog-modal">
        <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-dialog-cancel>✕</button></div>
        <p class="dialog-message">${esc(message)}</p>
        <input class="dialog-input" type="${esc(inputType)}" value="${esc(defaultValue)}" placeholder="${esc(placeholder)}" autocomplete="off">
        <div class="modal-actions">
          <button class="btn ghost" data-dialog-cancel>Cancelar</button>
          <button class="btn primary" data-dialog-ok>Aceptar</button>
        </div>
      </div>`;
    const input = overlay.querySelector(".dialog-input");
    const finish = (val) => {
      overlay.remove();
      resolve(val);
    };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll("[data-dialog-cancel]").forEach((b) => b.addEventListener("click", () => finish(null)));
    overlay.querySelector("[data-dialog-ok]").addEventListener("click", () => finish(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(input.value); }
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

function markdown(text) {
  const blocks = [];
  const raw = String(text || "").replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const cleaned = code.replace(/\n$/, "");
    const idx = blocks.length;
    blocks.push(
      `<div class="code-block"><div class="code-bar"><span>${esc(lang || "código")}</span><button type="button" class="msg-copy-btn code-copy-btn">Copiar</button></div><pre><code>${esc(cleaned)}</code></pre></div>`
    );
    return `\u0000CODEBLOCK_${idx}\u0000`;
  });
  let html = esc(raw);
  html = html.replace(/^###\s+(.*)$/gm, "<h4>$1</h4>");
  html = html.replace(/^##?\s+(.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  html = html.replace(/^\s*[-*]\s+(.*)$/gm, "• $1");
  html = html.replace(/\n/g, "<br>");
  html = html.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_m, idx) => blocks[Number(idx)] || "");
  return html;
}

async function api(path, options = {}) {
  const opts = { method: options.method || "GET", credentials: "same-origin", headers: {} };
  if (options.signal) opts.signal = options.signal;
  if (options.body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && !/^\/api\/(login|state|setup|access\/redeem)/.test(path)) {
    showLogin("code");
    throw new Error("Sesión caducada.");
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ login */

function showLogin(mode = "code") {
  $("app").hidden = true;
  $("login-screen").hidden = false;
  $("setup-view").hidden = mode !== "setup";
  $("code-view").hidden = mode !== "code";
  $("login-view").hidden = mode !== "classic";
  $("login-error").hidden = true;
  if (mode === "code") $("access-code-input")?.focus();
  else if (mode === "classic") $("login-name")?.focus();
  else $("setup-password")?.focus();
}

function loginError(message) {
  const box = $("login-error");
  box.textContent = message;
  box.hidden = false;
}

async function doAuth(path, payload) {
  try {
    const data = await api(path, { method: "POST", body: payload });
    state.user = data.user;
    state.pendingBootstrapPack = data.bootstrap_pack || null;
    if ($("access-code-input")) $("access-code-input").value = "";
    if ($("login-password")) $("login-password").value = "";
    if ($("setup-password")) $("setup-password").value = "";
    startApp();
  } catch (exc) {
    loginError(exc.message);
  }
}

function setVersion(version) {
  if (!version) return;
  const label = `· v${version}`;
  const appEl = $("app-version");
  const loginEl = $("login-version");
  if (appEl) appEl.textContent = label;
  if (loginEl) loginEl.textContent = label;
}

function isStandaloneMode() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function syncInstallButtons() {
  const show = !state.pwaInstalled && (Boolean(state.pwaPrompt) || state.pwaIOS);
  ["btn-install", "menu-install", "btn-install-login"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = !show;
  });
}

function openIOSInstallGuide() {
  openModal(
    `
    <div class="modal-head"><h2>⬇ Instalar AI Hub en iPhone / iPad</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
    <p class="shortcuts-intro">Safari permite añadir AI Hub a tu pantalla de inicio para abrirlo como aplicación en pantalla completa:</p>
    <ol class="ios-steps">
      <li>Pulsa el botón <strong>Compartir</strong> en la barra inferior o superior de Safari.</li>
      <li>Desliza hacia abajo y elige <strong>Añadir a pantalla de inicio</strong>.</li>
      <li>Pulsa <strong>Añadir</strong> para crear el icono de <strong>AI Hub</strong>.</li>
    </ol>
    <div class="modal-actions">
      <button type="button" class="btn primary small" data-close>Entendido</button>
    </div>`,
    "pwa-ios"
  );
}

async function triggerPWAInstall() {
  if (state.pwaInstalled) return;
  if (state.pwaPrompt) {
    const promptEvent = state.pwaPrompt;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice && choice.outcome === "accepted") {
        state.pwaInstalled = true;
        state.pwaPrompt = null;
        syncInstallButtons();
      }
    } catch {
      /* ignore prompt cancellation */
    }
    return;
  }
  if (state.pwaIOS) {
    openIOSInstallGuide();
  }
}

function syncOfflineBanner() {
  const banner = $("offline-banner");
  if (!banner) return;
  banner.hidden = navigator.onLine !== false;
}

function initPWA() {
  if (state.pwaInit) return;
  state.pwaInit = true;
  state.pwaInstalled = isStandaloneMode();
  state.pwaIOS = /iphone|ipad|ipod/i.test(navigator.userAgent || "");
  syncInstallButtons();
  syncOfflineBanner();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.pwaPrompt = event;
    syncInstallButtons();
  });

  window.addEventListener("appinstalled", () => {
    state.pwaInstalled = true;
    state.pwaPrompt = null;
    syncInstallButtons();
    toast("AI Hub instalada como aplicación.", "ok");
  });

  window.addEventListener("online", () => {
    syncOfflineBanner();
    toast("Conexión recuperada.", "ok");
  });
  window.addEventListener("offline", syncOfflineBanner);

  $("btn-install")?.addEventListener("click", triggerPWAInstall);
  $("btn-install-login")?.addEventListener("click", triggerPWAInstall);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* service worker unavailable in this context */
    });
  }
}

async function boot() {
  initPWA();
  try {
    const data = await api("/api/state");
    setVersion(data.version);
    if (!data.setup_required) {
      try {
        const me = await api("/api/me");
        state.user = me.user;
        startApp();
        return;
      } catch {
        /* sin sesión: se muestra el login */
      }
    }
    showLogin(data.setup_required ? "setup" : "code");
  } catch (exc) {
    showLogin("code");
    loginError("No se pudo conectar con el servidor.");
  }
}

async function applyBootstrapPack(pack) {
  if (!pack || typeof pack !== "object" || !state.vault) return { changed: false, providersAdded: 0, keysAdded: 0 };
  let changed = false;
  let providersAdded = 0;
  let keysAdded = 0;

  const orKey = typeof pack.openrouter_api_key === "string" ? pack.openrouter_api_key.trim() : "";
  if (orKey) {
    if (!Array.isArray(state.vault.custom_providers)) state.vault.custom_providers = [];
    const existingOr = state.vault.custom_providers.find((p) =>
      String(p.base || "").toLowerCase().includes("openrouter.ai")
    );
    if (existingOr) {
      if (!existingOr.key) {
        existingOr.key = orKey;
        changed = true;
        keysAdded += 1;
      }
    } else {
      state.vault.custom_providers.push({
        id: uniqueCustomProviderId("openrouter"),
        name: "OpenRouter",
        base: "https://openrouter.ai/api/v1",
        key: orKey,
        glyph: "↗",
        color: "#f2b84b",
        categories: ["code", "media"],
      });
      changed = true;
      providersAdded += 1;
      keysAdded += 1;
    }
  }

  if (Array.isArray(pack.custom_providers) && pack.custom_providers.length) {
    if (!Array.isArray(state.vault.custom_providers)) state.vault.custom_providers = [];
    for (const incoming of pack.custom_providers) {
      if (!incoming || !incoming.base || !incoming.name) continue;
      const cleanBase = String(incoming.base).trim().replace(/\/+$/, "");
      const existing = state.vault.custom_providers.find(
        (p) => p.id === incoming.id || p.base.toLowerCase() === cleanBase.toLowerCase()
      );
      if (existing) {
        if (incoming.key && !existing.key) {
          existing.key = String(incoming.key).trim();
          changed = true;
          keysAdded += 1;
        }
      } else {
        const cleanId = state.vault.custom_providers.some((p) => p.id === incoming.id)
          ? uniqueCustomProviderId(incoming.id)
          : String(incoming.id);
        state.vault.custom_providers.push({
          id: cleanId,
          name: String(incoming.name),
          base: cleanBase,
          key: String(incoming.key || "").trim(),
          glyph: String(incoming.glyph || "◆"),
          color: String(incoming.color || "#9aa4b2"),
          categories: Array.isArray(incoming.categories) && incoming.categories.length ? incoming.categories : ["code"],
        });
        changed = true;
        providersAdded += 1;
        if (incoming.key) keysAdded += 1;
      }
    }
  }

  if (changed) {
    await saveUserVault();
    syncStateFromVault();
  }
  return { changed, providersAdded, keysAdded };
}

/* ------------------------------------------------------------------ inicio */

async function startApp() {
  $("login-screen").hidden = true;
  $("app").hidden = false;
  $("btn-admin").hidden = state.user.role !== "admin";
  $("menu-admin").hidden = state.user.role !== "admin";
  $("btn-user").textContent = state.user.name;
  syncInstallButtons();
  await loadUserVault(state.user.id);
  await maybeMigrateLegacyVault();
  let packResult = { changed: false, providersAdded: 0, keysAdded: 0 };
  if (state.pendingBootstrapPack) {
    const pack = state.pendingBootstrapPack;
    state.pendingBootstrapPack = null;
    packResult = await applyBootstrapPack(pack);
  }
  const legacyPrefs = JSON.parse(localStorage.getItem("aihub.web") || "{}");
  const prefs = { ...legacyPrefs, ...((state.vault && state.vault.prefs) || {}) };
  const validGroups = new Set(["all", ...DEFAULT_GROUPS.map((g) => g.id)]);
  state.group = validGroups.has(prefs.group) ? prefs.group : "all";
  state.sort = prefs.sort || "price-asc";
  state.filter = prefs.filter || "all";
  state.providerFilter = prefs.provider || null;
  state.autoSwitchFree = prefs.auto_switch_free !== false;
  state.mobile = isPhone();
  if (state.mobile) $("layout").classList.add("collapsed");
  $("sort").value = state.sort;
  $("filter").value = state.filter;
  if ($("auto-switch-free")) $("auto-switch-free").checked = state.autoSwitchFree;
  syncTabs();
  bindEvents();
  await loadCatalog();
  if (packResult.changed) {
    const bits = [];
    if (packResult.providersAdded) bits.push(`${packResult.providersAdded} proveedor${packResult.providersAdded === 1 ? "" : "es"}`);
    if (packResult.keysAdded) bits.push(`${packResult.keysAdded} clave${packResult.keysAdded === 1 ? "" : "s"}`);
    toast(`Configuración inicial guardada en tu disco duro (${bits.join(" · ")}).`, "ok");
    await refreshCatalog(true);
  }
  const active = (state.projects || []).find((item) => item.active);
  const savedProject = localStorage.getItem("aihub.project");
  if (active) {
    state.project = active.id;
  } else if (savedProject && (state.projects || []).some((item) => item.id === savedProject)) {
    state.project = savedProject;
  }
  renderProjectChip();
  await loadFiles();
  await loadHistory();
  if (isPhone()) {
    $("layout").classList.add("collapsed");
    updateBackdrop();
  }
}

function savePrefs() {
  const next = {
    group: state.group,
    sort: state.sort,
    filter: state.filter,
    provider: state.providerFilter,
    selected_model: state.selected ? `${state.selected.provider}::${state.selected.uid}` : "",
    auto_switch_free: state.autoSwitchFree,
  };
  localStorage.setItem("aihub.web", JSON.stringify(next));
  if (state.vault) {
    state.vault.prefs = next;
    saveUserVault();
  }
}

function syncTabs() {
  document.querySelectorAll("#tabs .tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.group === state.group);
  });
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;

  document.querySelectorAll("#tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.group = btn.dataset.group || "all";
      savePrefs();
      syncTabs();
      renderProviders();
      renderModels();
    });
  });

  $("provider-current").addEventListener("click", () => {
    const menu = $("provider-menu");
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (event) => {
    const select = $("provider-select");
    if (!select || select.contains(event.target)) return;
    $("provider-menu").hidden = true;
  });

  $("model-list").addEventListener("click", (event) => {
    const provHead = event.target.closest(".provider-section-head");
    if (provHead) {
      const pid = provHead.dataset.providerId;
      if (state.collapsedProviders.has(pid)) state.collapsedProviders.delete(pid);
      else state.collapsedProviders.add(pid);
      renderModels();
      return;
    }
    const groupHead = event.target.closest(".group-section-head");
    if (groupHead) {
      const key = groupHead.dataset.groupKey;
      if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
      else state.collapsedGroups.add(key);
      renderModels();
      return;
    }
    const row = event.target.closest(".model-row");
    if (!row || row.classList.contains("disabled")) return;
    const model = state.models.find((item) => item.uid === row.dataset.uid && item.provider === row.dataset.provider);
    if (model) selectModel(model);
  });

  $("search").addEventListener("input", debounce((event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderModels();
  }, 150));
  $("search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = $("model-list").querySelector(".model-row:not(.disabled)");
      if (first) {
        event.preventDefault();
        const model = state.models.find((item) => item.uid === first.dataset.uid && item.provider === first.dataset.provider);
        if (model) {
          selectModel(model);
          $("prompt")?.focus();
        }
      }
    }
  });

  $("filter").addEventListener("change", (event) => {
    state.filter = event.target.value;
    savePrefs();
    renderModels();
  });

  $("sort").addEventListener("change", (event) => {
    state.sort = event.target.value;
    savePrefs();
    renderModels();
  });

  $("btn-collapse").addEventListener("click", () => toggleSidebar(true));
  $("rail-open").addEventListener("click", () => toggleSidebar(false));
  $("btn-models-mobile").addEventListener("click", () => toggleSidebar(false));
  $("btn-mobile-menu").addEventListener("click", (event) => {
    event.stopPropagation();
    $("mobile-menu").hidden = !$("mobile-menu").hidden;
  });
  $("mobile-menu").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button) handleAction(button.dataset.action);
  });
  document.addEventListener("click", (event) => {
    const menu = $("mobile-menu");
    if (!menu || menu.hidden) return;
    if (menu.contains(event.target) || event.target.closest("#btn-mobile-menu")) return;
    menu.hidden = true;
  });
  $("backdrop").addEventListener("click", closeDrawers);

  $("btn-refresh").addEventListener("click", () => refreshCatalog(true));
  $("btn-project").addEventListener("click", openProjects);
  $("btn-history").addEventListener("click", openHistory);
  $("btn-detail").addEventListener("click", toggleDetail);
  $("btn-settings").addEventListener("click", () => openSettings("main"));
  $("btn-admin").addEventListener("click", () => openSettings("admin"));
  $("btn-user").addEventListener("click", () => openSettings("account"));
  $("btn-shortcuts")?.addEventListener("click", openShortcuts);
  $("btn-help").addEventListener("click", openHelp);
  $("btn-logout").addEventListener("click", logout);

  $("btn-clear").addEventListener("click", clearChat);
  $("btn-send").addEventListener("click", () => sendChat());
  $("auto-switch-free")?.addEventListener("change", (event) => {
    state.autoSwitchFree = Boolean(event.target.checked);
    savePrefs();
  });
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendChat();
    }
  });
  $("prompt").addEventListener("input", (event) => {
    const el = event.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  });
  $("messages").addEventListener("click", (event) => {
    const codeBtn = event.target.closest(".code-copy-btn");
    if (codeBtn) {
      const code = codeBtn.closest(".code-block")?.querySelector("code")?.textContent || "";
      copyText(code);
      return;
    }
    const msgBtn = event.target.closest("[data-copy-msg]");
    if (msgBtn) {
      const msg = msgBtn.closest(".msg");
      copyText(msg?.dataset.raw || msg?.querySelector(".msg-body")?.textContent || "");
      return;
    }
    if (event.target.closest(".error-open-settings")) {
      openSettings("main");
    }
  });
  $("btn-stop").addEventListener("click", () => {
    if (state.controller) state.controller.abort();
  });

  $("btn-generate").addEventListener("click", generate);
  $("btn-gen-cancel").addEventListener("click", () => {
    if (state.controller) state.controller.abort();
  });

  $("btn-file-up").addEventListener("click", () => {
    if (!state.filePath) return;
    const parts = state.filePath.split("/").filter(Boolean);
    parts.pop();
    state.filePath = parts.join("/");
    loadFiles();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      $("mobile-menu").hidden = true;
      closeDrawers();
      return;
    }
    if ($("app").hidden) return;
    const modal = activeModalName();
    const mod = event.ctrlKey || event.metaKey;
    const key = (event.key || "").toLowerCase();

    if ((mod && !event.altKey && (event.key === "/" || event.code === "Slash")) ||
        (!mod && !event.altKey && event.key === "?" && !isEditableTarget(event.target))) {
      if (modal && modal !== "shortcuts") return;
      event.preventDefault();
      toggleShortcuts();
      return;
    }

    if (modal && modal !== "shortcuts") return;

    if (mod && !event.shiftKey && !event.altKey && key === "n") {
      event.preventDefault();
      if (modal === "shortcuts") closeModal();
      clearChat();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && key === "b") {
      event.preventDefault();
      if (modal === "shortcuts") closeModal();
      toggleSidebar();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && key === "i") {
      event.preventDefault();
      if (modal === "shortcuts") closeModal();
      focusPromptInput();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && key === "f") {
      event.preventDefault();
      if (modal === "shortcuts") closeModal();
      if ($("layout").classList.contains("collapsed")) toggleSidebar(false);
      const search = $("search");
      if (search) {
        search.focus();
        search.select();
      }
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      if (modal === "shortcuts") closeModal();
      refreshCatalog(true);
    }
  });

  window.addEventListener("resize", debounce(() => {
    if (isPhone()) {
      $("layout").classList.add("collapsed");
      $("layout").classList.remove("show-detail");
    } else {
      $("layout").classList.remove("collapsed", "show-detail");
    }
    updateBackdrop();
  }, 180));
}

function toggleSidebar(forceCollapsed) {
  const layout = $("layout");
  const collapsed = typeof forceCollapsed === "boolean" ? forceCollapsed : !layout.classList.contains("collapsed");
  layout.classList.toggle("collapsed", collapsed);
  if (!collapsed) layout.classList.remove("show-detail");
  updateBackdrop();
}

function toggleDetail() {
  const layout = $("layout");
  layout.classList.toggle("show-detail");
  if (layout.classList.contains("show-detail")) layout.classList.add("collapsed");
  updateBackdrop();
}

function closeDrawers() {
  const layout = $("layout");
  layout.classList.add("collapsed");
  layout.classList.remove("show-detail");
  $("mobile-menu").hidden = true;
  updateBackdrop();
}

function updateBackdrop() {
  const layout = $("layout");
  const open = !layout.classList.contains("collapsed") || layout.classList.contains("show-detail");
  $("backdrop").hidden = !(open && isNarrow());
}

function focusPromptInput() {
  if (isNarrow()) closeDrawers();
  const target = $("generator") && !$("generator").hidden ? $("gen-prompt") : $("prompt");
  if (target) {
    target.focus();
    const len = target.value.length;
    try { target.setSelectionRange(len, len); } catch { /* ignore */ }
  }
}

function handleAction(action) {
  $("mobile-menu").hidden = true;
  if (action === "models") toggleSidebar(false);
  else if (action === "project") openProjects();
  else if (action === "history") openHistory();
  else if (action === "detail") toggleDetail();
  else if (action === "refresh") refreshCatalog(true);
  else if (action === "settings") openSettings("main");
  else if (action === "admin") openSettings("admin");
  else if (action === "account") openSettings("account");
  else if (action === "install") triggerPWAInstall();
  else if (action === "shortcuts") openShortcuts();
  else if (action === "help") openHelp();
  else if (action === "logout") logout();
}

/* ------------------------------------------------------------------ catálogo */

async function loadCatalog() {
  const data = await api("/api/catalog");
  setVersion(data.version);
  state.baseProviders = data.base_providers || data.providers || [];
  state.presets = data.presets || (data.settings && data.settings.presets) || [];
  if (Array.isArray(data.groups) && data.groups.length) state.groups = data.groups;
  state.projects = data.projects || [];
  state.settings = data.settings || state.settings;
  syncStateFromVault();

  const preferred = (state.vault && state.vault.prefs && state.vault.prefs.selected_model) || localStorage.getItem("aihub.model");
  if (preferred) {
    const [provider, uid] = preferred.split("::");
    const found = state.models.find((item) => item.provider === provider && item.uid === uid);
    if (found) selectModel(found, false);
  }
  renderProviders();
  renderModels();
  renderProjectChip();
  if (state.providers.length > 0 && !state.models.length) {
    await refreshCatalog(false);
  }
  if (!state.selected && state.models.length) {
    const freeChat = state.models
      .filter((item) => item.category === "code" && item.free)
      .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
    const first = freeChat[0]
      || state.models.find((item) => item.category === "code")
      || state.models[0];
    if (first) selectModel(first, false);
  }
}

async function refreshCatalog(showOverlay, onlyProviders = null) {
  if (state.busy) return;
  if (showOverlay) showLoading("Actualizando catálogos…");
  try {
    const body = {
      stateless: true,
      custom_providers: (state.vault && state.vault.custom_providers) || [],
    };
    if (Array.isArray(onlyProviders) && onlyProviders.length) {
      body.providers = onlyProviders;
    }
    const data = await api("/api/refresh", { method: "POST", body });
    if (Array.isArray(data.groups) && data.groups.length) state.groups = data.groups;
    const grouped = {};
    for (const m of data.models || []) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m);
    }
    if (state.vault) {
      const updatedIds = new Set(data.updated || Object.keys(grouped));
      for (const pid of updatedIds) {
        if (grouped[pid] || !(data.errors && data.errors[pid])) {
          state.vault.models_by_provider[pid] = grouped[pid] || [];
        }
      }
      await saveUserVault();
    }
    syncStateFromVault();
    renderProviders();
    renderModels();
    const errors = data.errors || {};
    const keys = Object.keys(errors);
    if (keys.length) {
      keys.slice(0, 3).forEach((key) => toast(`${key}: ${errors[key]}`, "error"));
    } else {
      toast("Catálogos actualizados en tu disco duro local.", "ok");
    }
  } catch (exc) {
    toast(exc.message, "error");
  } finally {
    hideLoading();
  }
}

function modelGroupId(model) {
  if (model && model.group) return model.group;
  if (model && model.category === "image") return "image";
  if (model && model.category === "video") return "video";
  return "chat";
}

function groupMatches(model) {
  if (state.group === "all") return true;
  return modelGroupId(model) === state.group;
}

function renderProviders() {
  const current = $("provider-current");
  const menu = $("provider-menu");
  if (!current || !menu) return;
  const counts = {};
  for (const model of state.models) {
    if (!groupMatches(model)) continue;
    counts[model.provider] = counts[model.provider] || { total: 0, free: 0 };
    counts[model.provider].total += 1;
    if (model.free) counts[model.provider].free += 1;
  }
  const active = state.providers.find((item) => item.id === state.providerFilter);
  current.innerHTML = active
    ? `<span class="provider-logo" style="background:${esc(active.color)}">${esc(active.glyph)}</span> <span>${esc(active.name)}</span>`
    : "Todos los proveedores";
  menu.innerHTML = "";
  const all = document.createElement("button");
  all.type = "button";
  all.className = "provider-item" + (state.providerFilter ? "" : " active");
  all.innerHTML = `<span class="provider-logo" style="background:var(--panel-3)">＋</span> <span>Todos los proveedores</span>`;
  all.addEventListener("click", () => selectProvider(null));
  menu.appendChild(all);
  for (const provider of state.providers) {
    const count = counts[provider.id] || { total: 0, free: 0 };
    if (!count.total && state.group !== "all") continue;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "provider-item" + (state.providerFilter === provider.id ? " active" : "");
    item.innerHTML = `<span class="provider-logo" style="background:${esc(provider.color)}">${esc(provider.glyph)}</span>
      <span>${esc(provider.name)}</span> <small>${count.free}/${count.total}</small>`;
    item.addEventListener("click", () => selectProvider(provider.id));
    menu.appendChild(item);
  }
}

function selectProvider(id) {
  state.providerFilter = id || null;
  savePrefs();
  renderProviders();
  renderModels();
  $("provider-menu").hidden = true;
}

function historyTokens() {
  let total = 0;
  for (const item of state.messages || []) {
    if (!item || typeof item !== "object") continue;
    const content = textOf(item.content);
    total += Math.ceil((content || "").length / 4);
    if (Array.isArray(item.images)) total += item.images.length * 800;
  }
  return total;
}

function modelContextLimit(model) {
  const c = Number(model && model.context);
  if (c > 0) return c;
  return (model && String(model.provider || "").toLowerCase().includes("ollama")) ? 8192 : 32768;
}

function isModelContextDisabled(model) {
  if (!model || model.category !== "code") return false;
  if (state.filter !== "free") return false;
  if (!model.free) return false;
  const required = Math.max(historyTokens() + 1024, 2048);
  return modelContextLimit(model) < required;
}

function sortFreeModels(items) {
  return [...items].sort((a, b) => {
    if (state.sort === "name") return a.name.localeCompare(b.name);
    if (state.sort === "context") return (b.context || 0) - (a.context || 0) || (b.relevance_score || 0) - (a.relevance_score || 0);
    if (
      String(a.provider || "").toLowerCase().includes("ollama") &&
      String(b.provider || "").toLowerCase().includes("ollama")
    ) {
      const ia = a.extra && a.extra.installed ? 1 : 0;
      const ib = b.extra && b.extra.installed ? 1 : 0;
      if (ia !== ib) return ib - ia;
    }
    const rel = (b.relevance_score || 0) - (a.relevance_score || 0);
    if (rel !== 0) return rel;
    return a.name.localeCompare(b.name);
  });
}

function sortPaidModels(items) {
  return [...items].sort((a, b) => {
    if (state.sort === "name") return a.name.localeCompare(b.name);
    if (state.sort === "context") return (b.context || 0) - (a.context || 0) || (a.effective_price ?? Infinity) - (b.effective_price ?? Infinity);
    const aUnknown = a.effective_price == null;
    const bUnknown = b.effective_price == null;
    if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
    if (state.sort === "price-desc") {
      return (b.effective_price ?? -1) - (a.effective_price ?? -1) || a.name.localeCompare(b.name);
    }
    return (a.effective_price ?? Infinity) - (b.effective_price ?? Infinity) || a.name.localeCompare(b.name);
  });
}

function isModelDownloadable(model) {
  if (!model) return false;
  if (model.extra && model.extra.downloadable) return true;
  if (
    model.extra &&
    model.extra.installed === false &&
    (String(model.provider || "").toLowerCase().includes("ollama") || model.unit === "local")
  ) {
    return true;
  }
  return false;
}

function isModelLocalInstalled(model) {
  return Boolean(
    model &&
      model.extra &&
      model.extra.installed === true &&
      (String(model.provider || "").toLowerCase().includes("ollama") || model.unit === "local")
  );
}

function normTagKey(tag) {
  const base = String(tag || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (base === "free") return "gratis";
  if (base === "reasoning") return "razonamiento";
  if (base === "vision") return "vision";
  if (base === "image") return "imagen";
  if (base === "video") return "video";
  return base;
}

function dedupeDetailTags(model) {
  const seen = new Set();
  const badges = [];
  if (model.group_label) {
    const gKey = normTagKey(model.group_label);
    if (gKey) {
      seen.add(gKey);
      for (const part of gKey.split(/\s+y\s+/)) {
        if (part) seen.add(part.trim());
      }
    }
    badges.push(model.group_label);
  }
  if (model.free) {
    // Ya se muestra el precio "Gratis" en verde justo encima; evita duplicarlo en etiquetas
    seen.add("gratis");
  }
  for (const tag of model.tags || []) {
    const clean = String(tag || "").trim();
    if (!clean) continue;
    const key = normTagKey(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    badges.push(clean);
  }
  return badges;
}

function buildModelRow(model) {
  const row = document.createElement("div");
  const disabled = isModelContextDisabled(model);
  const selected = state.selected && state.selected.uid === model.uid && state.selected.provider === model.provider;
  const downloadable = isModelDownloadable(model);
  const installedLocal = isModelLocalInstalled(model);
  row.className = "model-row" + (selected ? " selected" : "") + (disabled ? " disabled" : "");
  if (disabled) row.title = "Contexto insuficiente para la conversación actual";
  else if (downloadable) row.title = `Requiere descarga local: ollama pull ${model.uid}`;
  row.dataset.uid = model.uid;
  row.dataset.provider = model.provider;
  const priceClass = model.free ? "free" : (model.effective_price == null ? "unknown" : "");
  const badgeHtml = downloadable
    ? `<span class="model-badge download" title="Requiere descarga antes de usar">⬇ Descargar</span>`
    : installedLocal
      ? `<span class="model-badge installed" title="Instalado en local">✓ Local</span>`
      : "";
  row.innerHTML = `
    <span class="model-glyph" style="color:${esc(model.provider_color)}">${esc(model.provider_glyph)}</span>
    <div class="model-main">
      <div class="model-name"><span class="model-name-text">${esc(model.name)}</span>${badgeHtml}</div>
      <div class="model-sub">${esc(model.info_text)}</div>
    </div>
    <div class="model-price ${priceClass}">${esc(model.price_text)}</div>`;
  return row;
}

function renderModels() {
  const root = $("model-list");
  root.innerHTML = "";
  let items = state.models.filter(groupMatches);
  if (state.filter === "favorites") {
    items = items.filter((item) => state.favorites.includes(`${item.provider}:${item.uid}`));
  } else {
    if (state.providerFilter) items = items.filter((item) => item.provider === state.providerFilter);
    if (state.filter === "free") items = items.filter((item) => item.free);
    if (state.filter === "paid") items = items.filter((item) => !item.free);
  }
  if (state.search) {
    items = items.filter((item) =>
      (item.name + " " + item.uid + " " + (item.group_label || "") + " " + (item.desc || "")).toLowerCase().includes(state.search)
    );
  }
  $("model-count").textContent = `${items.length} modelo${items.length === 1 ? "" : "s"}`;
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "model-list-empty";
    if (!state.providers.length) {
      empty.innerHTML = `
        <p style="margin:0 0 10px">Todavía no has añadido ningún proveedor (OpenRouter, Ollama, OpenCode, OpenAI, Gemini, Groq…).</p>
        <button type="button" class="btn primary small" id="btn-empty-add-provider">⚙ Añadir proveedores</button>`;
      empty.querySelector("#btn-empty-add-provider")?.addEventListener("click", () => openSettings("main"));
    } else {
      empty.textContent = "No hay modelos para este filtro. Pulsa «Actualizar» para descargar el catálogo.";
    }
    root.appendChild(empty);
    return;
  }

  const byProvider = new Map();
  for (const model of items) {
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
    byProvider.get(model.provider).push(model);
  }

  const providerMeta = new Map(state.providers.map((p) => [p.id, p]));
  const orderedProviderIds = [
    ...state.providers.map((p) => p.id).filter((id) => byProvider.has(id)),
    ...[...byProvider.keys()].filter((id) => !providerMeta.has(id)),
  ];
  const groupDefs = state.groups && state.groups.length ? state.groups : DEFAULT_GROUPS;
  const isSearching = Boolean(state.search);
  const frag = document.createDocumentFragment();

  for (const pid of orderedProviderIds) {
    const pModels = byProvider.get(pid) || [];
    const pInfo = providerMeta.get(pid) || {
      id: pid,
      name: pModels[0]?.provider_name || pid,
      glyph: pModels[0]?.provider_glyph || "◆",
      color: pModels[0]?.provider_color || "#8b93a7",
    };
    const pFreeCount = pModels.filter((m) => m.free).length;
    const pPaidCount = pModels.length - pFreeCount;
    const pCollapsed = !isSearching && !state.providerFilter && state.collapsedProviders.has(pid);

    const pSection = document.createElement("div");
    pSection.className = "provider-section";

    const pHead = document.createElement("button");
    pHead.type = "button";
    pHead.className = "provider-section-head";
    pHead.dataset.providerId = pid;
    const pCountBits = [];
    if (pFreeCount) pCountBits.push(`${pFreeCount} gratis`);
    if (pPaidCount) pCountBits.push(`${pPaidCount} pago`);
    pHead.innerHTML = `
      <span class="chevron">${pCollapsed ? "▸" : "▾"}</span>
      <span class="provider-badge" style="background:${esc(pInfo.color)}">${esc(pInfo.glyph)}</span>
      <strong>${esc(pInfo.name)}</strong>
      <small>${esc(pCountBits.join(" · "))}</small>`;
    pSection.appendChild(pHead);

    if (!pCollapsed) {
      const byGroup = new Map();
      for (const model of pModels) {
        const gid = modelGroupId(model);
        if (!byGroup.has(gid)) byGroup.set(gid, []);
        byGroup.get(gid).push(model);
      }

      for (const gDef of groupDefs) {
        const gModels = byGroup.get(gDef.id);
        if (!gModels || !gModels.length) continue;

        const gKey = `${pid}:${gDef.id}`;
        const gFree = sortFreeModels(gModels.filter((m) => m.free));
        const gPaid = sortPaidModels(gModels.filter((m) => !m.free));
        const gCollapsed = !isSearching && state.group === "all" && state.collapsedGroups.has(gKey);

        const gSection = document.createElement("div");
        gSection.className = "group-section";

        const gHead = document.createElement("button");
        gHead.type = "button";
        gHead.className = "group-section-head";
        gHead.dataset.groupKey = gKey;
        const gBits = [];
        if (gFree.length) gBits.push(`${gFree.length} gratis`);
        if (gPaid.length) gBits.push(`${gPaid.length} pago`);
        gHead.innerHTML = `
          <span class="chevron">${gCollapsed ? "▸" : "▾"}</span>
          <span class="group-icon">${esc(gDef.icon)}</span>
          <span class="group-title">${esc(gDef.label)}</span>
          <span class="group-counts">${esc(gBits.join(" · "))}</span>`;
        gSection.appendChild(gHead);

        if (!gCollapsed) {
          const tiers =
            state.sort === "price-desc"
              ? [
                  { kind: "paid", label: "De pago", hint: "precio ↓", list: gPaid },
                  { kind: "free", label: "Gratis", hint: "por relevancia", list: gFree },
                ]
              : [
                  {
                    kind: "free",
                    label: "Gratis",
                    hint: state.sort === "name" ? "A–Z" : state.sort === "context" ? "contexto ↓" : "por relevancia",
                    list: gFree,
                  },
                  {
                    kind: "paid",
                    label: "De pago",
                    hint: state.sort === "name" ? "A–Z" : state.sort === "context" ? "contexto ↓" : "precio ↑",
                    list: gPaid,
                  },
                ];

          for (const tier of tiers) {
            if (!tier.list.length) continue;
            const tHead = document.createElement("div");
            tHead.className = `tier-head ${tier.kind}`;
            tHead.innerHTML = `<span>${esc(tier.label)} (${tier.list.length})</span><small>${esc(tier.hint)}</small>`;
            gSection.appendChild(tHead);
            for (const model of tier.list) {
              gSection.appendChild(buildModelRow(model));
            }
          }
        }
        pSection.appendChild(gSection);
      }
    }
    frag.appendChild(pSection);
  }
  root.appendChild(frag);
}

function selectModel(model, collapseOnMobile = true) {
  state.selected = model;
  const grp = modelGroupId(model);
  if (state.group !== "all" && state.group !== grp) {
    state.group = grp;
    savePrefs();
    syncTabs();
    renderProviders();
  }
  state.collapsedProviders.delete(model.provider);
  state.collapsedGroups.delete(`${model.provider}:${grp}`);
  localStorage.setItem("aihub.model", `${model.provider}::${model.uid}`);
  savePrefs();
  renderModels();
  renderDetail();
  renderCenterMode();
  updateConvContext();
  const toolsBox = $("tools-label");
  if (model.category !== "code") toolsBox.style.opacity = "0.45";
  else toolsBox.style.opacity = "1";
  if (collapseOnMobile && isPhone()) {
    $("layout").classList.add("collapsed");
    updateBackdrop();
  }
}

function renderDetail() {
  const root = $("model-detail");
  const model = state.selected;
  if (!model) {
    root.innerHTML = `<small class="empty">Elige un modelo para ver su precio y detalles.</small>`;
    $("usage-text").textContent = "Elige un modelo para ver su consumo.";
    $("quota-text").textContent = "";
    if ($("usage-bars")) $("usage-bars").innerHTML = "";
    return;
  }
  const isFavorite = (state.favorites || []).includes(`${model.provider}:${model.uid}`);
  const downloadable = isModelDownloadable(model);
  const tags = dedupeDetailTags(model)
    .map((tag) => `<span class="tag">${esc(tag)}</span>`)
    .join("");
  const downloadNotice = downloadable
    ? `<div class="download-callout">
         <div><strong>⬇ Este modelo requiere descarga previa</strong> en tu equipo antes de chatear con él.</div>
         <code>ollama pull ${esc(model.uid)}</code>
         <button type="button" id="btn-copy-pull" class="btn ghost mini" style="align-self:flex-start">📋 Copiar comando</button>
       </div>`
    : "";
  root.innerHTML = `
    <div class="detail-title">
      <span class="model-glyph" style="color:${esc(model.provider_color)}">${esc(model.provider_glyph)}</span>
      <div>
        <strong>${esc(model.name)}</strong>
        <div class="usage-dim">${esc(model.provider_name)} · ${esc(model.uid)}</div>
      </div>
    </div>
    <div class="detail-price ${model.free ? "" : "paid"}">${esc(model.price_text)}</div>
    <div class="usage-dim">${esc(model.price_detail)}</div>
    ${downloadNotice}
    <div class="detail-desc">${esc(model.desc || "")}</div>
    <div class="detail-tags">${tags}</div>
    <div class="usage-dim" style="margin-top:8px">${esc(model.context_text)} contexto · ${esc(model.unit)}</div>
    <div class="detail-actions">
      <button id="btn-favorite" class="btn ghost small">${isFavorite ? "★ Favorito" : "☆ Favorito"}</button>
      <button id="btn-copy-id" class="btn ghost small" title="Copiar el identificador del modelo">Copiar ID</button>
    </div>`;
  $("btn-favorite").addEventListener("click", toggleFavorite);
  $("btn-copy-id").addEventListener("click", () => copyText(model.uid));
  $("btn-copy-pull")?.addEventListener("click", () => copyText(`ollama pull ${model.uid}`));
  $("conv-title").textContent = model.name;
  $("conv-sub").textContent = `${model.provider_name} · ${model.group_label || ""} · ${model.price_text}${downloadable ? " · ⬇ Requiere descarga" : ""}`;
  loadUsage();
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(String(value));
    toast("Copiado.", "ok");
  } catch {
    toast("No se pudo copiar.", "error");
  }
}

function renderUsageBarHtml({ label, pct, usedText, remainingText }) {
  const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const tone = clamped >= 85 ? "danger" : clamped >= 60 ? "warn" : "";
  return `
    <div class="usage-meter">
      <div class="usage-meter-head">
        <strong>${esc(label)}</strong>
        <span>${clamped}%</span>
      </div>
      <div class="usage-bar">
        <div class="usage-progress ${tone}" style="width:${clamped}%"></div>
      </div>
      <div class="usage-meter-sub">
        <span>Lleva: ${esc(usedText)}</span>
        <span>Queda: ${esc(remainingText)}</span>
      </div>
    </div>`;
}

async function getOpenRouterQuotaCached(apiKey) {
  if (!apiKey) return null;
  const cached = state.quotaCache.get(apiKey);
  if (cached && Date.now() - cached.ts < 120_000) return cached.data;
  try {
    const data = await api("/api/check", { method: "POST", body: { openrouter_api_key: apiKey } });
    if (data && data.ok) {
      state.quotaCache.set(apiKey, { ts: Date.now(), data });
      return data;
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function loadUsage(refreshQuota = false) {
  const model = state.selected;
  if (!model) return;
  const stats = getLocalUsage(model.provider, model.uid);
  $("usage-text").textContent = describeLocalUsage(stats);
  const today = stats.today || {};
  const bits = [];
  if (today.requests) bits.push(`${today.requests} petición${today.requests === 1 ? "" : "es"} hoy`);
  if (today.cost) bits.push(`$${Number(today.cost).toFixed(4)} hoy`);
  if (today.images) bits.push(`${today.images} imagen${today.images === 1 ? "" : "es"} hoy`);
  if (today.videos) bits.push(`${today.videos} vídeo${today.videos === 1 ? "" : "s"} hoy`);
  $("quota-text").textContent = bits.join(" · ");

  const barsEl = $("usage-bars");
  if (!barsEl) return;

  const bars = [];
  // 1. Barra de contexto actual del chat (tokens usados / restantes en la ventana del modelo)
  if (model.category === "code") {
    const ctxLimit = modelContextLimit(model);
    const ctxUsed = historyTokens();
    const ctxRem = Math.max(0, ctxLimit - ctxUsed);
    const ctxPct = ctxLimit > 0 ? (ctxUsed / ctxLimit) * 100 : 0;
    bars.push(
      renderUsageBarHtml({
        label: "Contexto del chat",
        pct: ctxPct,
        usedText: `~${fmtTokens(ctxUsed)} tokens`,
        remainingText: `~${fmtTokens(ctxRem)} de ${fmtTokens(ctxLimit)}`,
      })
    );
  }

  // 2. Barra de cuota real del proveedor (OpenRouter gratis/créditos si hay clave)
  const auth = getClientAuth(model.provider);
  const isOr =
    model.provider === "openrouter" ||
    Boolean(auth && auth.base && auth.base.toLowerCase().includes("openrouter.ai"));
  if (isOr && auth && auth.api_key) {
    if (refreshQuota) state.quotaCache.delete(auth.api_key);
    barsEl.innerHTML = bars.join("");
    const quota = await getOpenRouterQuotaCached(auth.api_key);
    if (!state.selected || state.selected.provider !== model.provider || state.selected.uid !== model.uid) {
      return;
    }
    if (quota) {
      if (model.free && quota.free_limit != null && Number(quota.free_limit) > 0) {
        const lim = Number(quota.free_limit);
        const rem = Math.max(0, Number(quota.free_remaining ?? lim));
        const used = Math.max(0, Number(quota.free_used ?? (lim - rem)));
        bars.push(
          renderUsageBarHtml({
            label: "Cuota gratis hoy (OpenRouter)",
            pct: (used / lim) * 100,
            usedText: `${used} pet.`,
            remainingText: `${rem} de ${lim}`,
          })
        );
      } else if (quota.limit != null && Number(quota.limit) > 0) {
        const lim = Number(quota.limit);
        const rem = Math.max(0, Number(quota.remaining ?? 0));
        const used = Math.max(0, lim - rem);
        bars.push(
          renderUsageBarHtml({
            label: "Límite de clave (OpenRouter)",
            pct: (used / lim) * 100,
            usedText: `$${used.toFixed(3)}`,
            remainingText: `$${rem.toFixed(3)} de $${lim.toFixed(2)}`,
          })
        );
      } else if (quota.credits != null && quota.total_usage != null) {
        const rem = Math.max(0, Number(quota.credits));
        const used = Math.max(0, Number(quota.total_usage));
        const total = used + rem;
        if (total > 0) {
          bars.push(
            renderUsageBarHtml({
              label: "Saldo OpenRouter",
              pct: (used / total) * 100,
              usedText: `$${used.toFixed(3)}`,
              remainingText: `$${rem.toFixed(3)}`,
            })
          );
        }
      }
    }
  } else {
    // Barra orientativa de consumo diario local (tokens de hoy frente a la ventana del modelo)
    const todayTokens = (today.prompt || 0) + (today.completion || 0);
    const refCap = Math.max(modelContextLimit(model), 32768);
    if (todayTokens > 0 || today.requests > 0) {
      const rem = Math.max(0, refCap - todayTokens);
      bars.push(
        renderUsageBarHtml({
          label: "Consumo hoy (modelo)",
          pct: (todayTokens / refCap) * 100,
          usedText: `${fmtTokens(todayTokens)} tok · ${today.requests || 0} pet.`,
          remainingText: todayTokens >= refCap ? "Límite orientativo superado" : `${fmtTokens(rem)} tok`,
        })
      );
    }
  }

  barsEl.innerHTML = bars.join("");
}

async function toggleFavorite() {
  const model = state.selected;
  if (!model || !state.vault) return;
  const key = `${model.provider}:${model.uid}`;
  let favs = [...(state.vault.favorite_models || [])];
  if (favs.includes(key)) favs = favs.filter((item) => item !== key);
  else favs.push(key);
  state.vault.favorite_models = favs;
  state.favorites = favs;
  await saveUserVault();
  renderDetail();
  renderModels();
}

function renderCenterMode() {
  const model = state.selected;
  const isGenerator = model && (model.category === "image" || model.category === "video");
  $("composer").hidden = !!isGenerator;
  $("generator").hidden = !isGenerator;
  if (!isGenerator) return;
  const isVideo = model.category === "video";
  $("gen-title").textContent = isVideo ? "Generar vídeo" : "Generar imagen";
  $("gen-model").textContent = `${model.name} · ${model.price_text}`;
  $("gen-duration-wrap").hidden = !isVideo;
  $("gen-resolution-wrap").hidden = !isVideo;
  $("gen-aspect").hidden = false;
  $("gen-result").innerHTML = "";
}

/* ------------------------------------------------------------------ chat */

function addMessage(kind, text) {
  const root = $("messages");
  const item = document.createElement("div");
  item.className = "msg " + kind;
  if (kind === "user" || kind === "assistant") {
    item.dataset.raw = text || "";
    item.innerHTML = `<div class="msg-body"></div>` +
      (kind === "assistant" && text ? `<div class="msg-actions"><button type="button" class="msg-copy-btn" data-copy-msg>Copiar</button></div>` : "");
    item.querySelector(".msg-body").innerHTML = kind === "user" ? esc(text) : markdown(text);
  } else if (kind === "error" && /ajustes|clave/i.test(String(text || ""))) {
    item.innerHTML = `<span>${esc(text)}</span><button type="button" class="btn ghost mini error-action error-open-settings">Abrir Ajustes</button>`;
  } else {
    item.textContent = text;
  }
  root.appendChild(item);
  root.scrollTop = root.scrollHeight;
  return item;
}

function modelKey() {
  return state.selected ? `${state.selected.provider}:${state.selected.uid}` : "";
}

function renderMessages() {
  const root = $("messages");
  root.innerHTML = "";
  for (const item of state.messages || []) {
    const role = item.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(item.content);
    if (!text.trim()) continue;
    addMessage(role, text);
  }
  updateConvContext();
}

function updateConvContext(context) {
  const el = $("conv-context");
  if (!el) return;
  if (context && context.limit) {
    el.textContent = `${context.turns || 0} turno${context.turns === 1 ? "" : "s"} · ~${fmtTokens(context.tokens)} de ${fmtTokens(context.limit)} tokens`;
    return;
  }
  const turns = (state.messages || []).filter((item) => item.role === "user").length;
  if (!turns) {
    el.textContent = "";
    return;
  }
  const chars = state.messages.reduce((total, item) => total + textOf(item.content).length, 0);
  const est = fmtTokens(Math.round(chars / 4));
  const limit = state.selected ? ` de ${fmtTokens(modelContextLimit(state.selected))}` : "";
  el.textContent = `${turns} turno${turns === 1 ? "" : "s"} · ~${est}${limit} tokens`;
}

async function loadHistory() {
  if (!state.vault) return;
  const hist = state.vault.history || { items: [], current: null };
  state.history = hist.items || [];
  if (hist.current && Array.isArray(hist.current.messages) && hist.current.messages.length) {
    applyConversation(hist.current);
    return;
  }
  restoreLocalConversation();
}

function applyConversation(record) {
  state.conversationId = record.id || null;
  state.messages = (record.messages || [])
    .filter((item) => item && ["user", "assistant", "tool"].includes(item.role))
    .map((item) => ({ role: item.role, content: textOf(item.content) }));
  renderMessages();
  renderModels();
  if (record.model) {
    const index = String(record.model).indexOf(":");
    if (index > 0) {
      const provider = record.model.slice(0, index);
      const uid = record.model.slice(index + 1);
      const found = state.models.find((item) => item.provider === provider && item.uid === uid);
      if (found) selectModel(found, false);
    }
  }
}

function restoreLocalConversation() {
  let messages = [];
  try {
    messages = JSON.parse(localStorage.getItem("aihub.conversation") || "[]");
  } catch {
    messages = [];
  }
  if (!Array.isArray(messages) || !messages.length) return;
  state.messages = messages
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .map((item) => ({ role: item.role, content: textOf(item.content) }));
  renderMessages();
  if (state.messages.length) saveConversation();
}

async function saveConversation() {
  try {
    localStorage.setItem("aihub.conversation", JSON.stringify(state.messages || []));
  } catch {
    /* ignore */
  }
  if (!state.vault) return;
  if (!(state.messages || []).some((item) => item.role === "user")) return;
  if (!(state.messages || []).some((item) => item.role === "assistant" && textOf(item.content).trim())) return;
  const firstUser = (state.messages.find((m) => m.role === "user")?.content || "").split(/\s+/).join(" ").trim();
  const title = firstUser.length > 60 ? `${firstUser.slice(0, 57)}…` : firstUser || "Chat sin título";
  const record = {
    id: state.conversationId || String(Date.now()),
    title,
    model: modelKey(),
    messages: state.messages.map((m) => ({ role: m.role, content: textOf(m.content) })),
    updated: Date.now() / 1000,
  };
  state.conversationId = record.id;
  const items = [record, ...(state.vault.history.items || []).filter((i) => i.id !== record.id)].slice(0, 50);
  state.vault.history = { items, current: record };
  state.history = items;
  await saveUserVault();
}

async function clearChat() {
  if (state.busy) {
    toast("Espera a que termine la respuesta actual.", "error");
    return;
  }
  state.messages = [];
  state.conversationId = null;
  $("messages").innerHTML = "";
  updateConvContext();
  renderModels();
  try {
    localStorage.removeItem("aihub.conversation");
  } catch {
    /* ignore */
  }
  if (state.vault) {
    state.vault.history = { items: state.vault.history.items || [], current: null };
    await saveUserVault();
  }
  $("prompt").focus();
}

async function openHistory() {
  const hist = (state.vault && state.vault.history) || { items: [], current: null };
  state.history = hist.items || [];
  const currentId = hist.current && hist.current.id;
  const rows = state.history.length
    ? state.history.map((item) => `
      <div class="history-row${item.id === currentId ? " current" : ""}" data-id="${esc(item.id)}">
        <div class="history-main">
          <strong>${esc(item.title || "Chat sin título")}</strong>
          <small>${esc(item.model || "sin modelo")} · ${esc(fmtWhen(item.updated))}</small>
        </div>
        <div class="history-actions">
          <button class="btn ghost mini" data-open="${esc(item.id)}">Abrir</button>
          <button class="btn danger mini" data-remove="${esc(item.id)}">Borrar</button>
        </div>
      </div>`).join("")
    : '<p class="hint">Todavía no hay conversaciones guardadas en este equipo.</p>';
  openModal(`
    <div class="modal-head"><h2>Historial</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
    <section>
      <p class="hint">Tus conversaciones se guardan únicamente en tu propio disco duro${state.vaultFileName ? ` (vinculado a ${esc(state.vaultFileName)})` : ""}. Puedes exportar o vincular un archivo en ⚙ Ajustes.</p>
      <div class="history-list">${rows}</div>
      <div class="modal-actions">
        <button id="btn-history-new" class="btn ghost">＋ Nuevo chat</button>
      </div>
    </section>`);
  $("modal-root").querySelector("[data-close]").addEventListener("click", closeModal);
  $("btn-history-new").addEventListener("click", async () => {
    closeModal();
    await clearChat();
  });
  $("modal-root").querySelectorAll("[data-open]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.open;
      const found = (state.vault.history.items || []).find((item) => item.id === id);
      if (!found) {
        toast("Esa conversación no existe.", "error");
        return;
      }
      state.vault.history.current = found;
      await saveUserVault();
      applyConversation(found);
      closeModal();
      toast("Conversación abierta.", "ok");
    });
  });
  $("modal-root").querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const ok = await confirmModal(
        "Borrar conversación",
        "¿Borrar esta conversación del historial local?",
        "Borrar",
        true
      );
      if (!ok) return;
      const id = button.dataset.remove;
      state.vault.history.items = (state.vault.history.items || []).filter((item) => item.id !== id);
      if (state.vault.history.current && state.vault.history.current.id === id) {
        state.vault.history.current = null;
      }
      if (state.conversationId === id) {
        state.conversationId = null;
        state.messages = [];
        $("messages").innerHTML = "";
        updateConvContext();
      }
      await saveUserVault();
      await openHistory();
    });
  });
}

function renderShortcutKeys(combos) {
  return combos
    .map((keys) => keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(`<span class="kbd-sep">+</span>`))
    .join(`<span class="kbd-sep">o</span>`);
}

function openShortcuts() {
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  const groups = [
    {
      title: "CONVERSACIÓN",
      items: [
        { label: "Nuevo chat", note: "Limpia el hilo actual para empezar de cero", keys: [[mod, "N"]] },
        { label: "Enfocar el mensaje", note: "Coloca el cursor en el compositor o generador", keys: [[mod, "I"]] },
        { label: "Enviar consulta", note: "Dentro del campo de texto", keys: [["Enter"], [mod, "Enter"]] },
        { label: "Salto de línea", note: "Añade una línea sin enviar", keys: [["Shift", "Enter"]] },
      ],
    },
    {
      title: "NAVEGACIÓN Y MODELOS",
      items: [
        { label: "Mostrar u ocultar barra lateral", note: "Pliega o despliega el panel de modelos", keys: [[mod, "B"]] },
        { label: "Buscar modelo", note: "Abre el panel y enfoca el buscador", keys: [[mod, "F"]] },
        { label: "Usar primer resultado", note: "Con el foco en el buscador de modelos", keys: [["Enter"]] },
        { label: "Actualizar catálogos", note: "Vuelve a descargar modelos y precios", keys: [["F5"]] },
      ],
    },
    {
      title: "INTERFAZ",
      items: [
        { label: "Abrir o cerrar esta guía", note: "También pulsando ? fuera de un campo de texto", keys: [[mod, "/"], ["?"]] },
        { label: "Cerrar ventanas y paneles", note: "Cierra modales, menús y cajones laterales", keys: [["Esc"]] },
      ],
    },
  ];
  const groupsHtml = groups
    .map(
      (group) => `
      <div class="shortcut-group">
        <h3>${esc(group.title)}</h3>
        ${group.items
          .map(
            (item) => `
          <div class="shortcut-row">
            <div class="shortcut-desc">
              ${esc(item.label)}
              ${item.note ? `<small>${esc(item.note)}</small>` : ""}
            </div>
            <div class="shortcut-keys">${renderShortcutKeys(item.keys)}</div>
          </div>`
          )
          .join("")}
      </div>`
    )
    .join("");
  openModal(
    `
    <div class="modal-head"><h2>⌨ Atajos de teclado</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
    <p class="shortcuts-intro">Usa estas combinaciones desde cualquier pantalla de AI Hub para moverte más rápido.</p>
    <div class="shortcut-groups">${groupsHtml}</div>
    <div class="shortcuts-foot">
      <span class="hint">${isMacPlatform() ? "También funcionan con Ctrl." : "En macOS puedes usar ⌘ en lugar de Ctrl."}</span>
      <button type="button" class="btn ghost small" data-close>Entendido</button>
    </div>`,
    "shortcuts"
  );
}

function toggleShortcuts() {
  if (activeModalName() === "shortcuts") closeModal();
  else openShortcuts();
}

async function openHelp() {
  try {
    const data = await api("/api/help");
    const body = String(data.text || "")
      .split("\n\n")
      .map((block) => `<p>${esc(block).replace(/\n/g, "<br>")}</p>`)
      .join("");
    openModal(`
      <div class="modal-head"><h2>Cómo funciona la conversación</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
      <section class="help-text">${body}</section>
      <div class="modal-actions">
        <button type="button" id="btn-help-shortcuts" class="btn ghost small">⌨ Ver atajos de teclado</button>
        <button type="button" class="btn primary small" data-close>Cerrar</button>
      </div>`);
    $("btn-help-shortcuts")?.addEventListener("click", openShortcuts);
  } catch (exc) {
    toast(exc.message, "error");
  }
}

function isQuotaOrLimitError(message) {
  const low = String(message || "").toLowerCase();
  return /(429|402|rate[\s_-]?limit|too many requests|quota|cuota|l[ií]mite|agotado|sin saldo|cr[eé]dito|credit|exhausted|exceeded|insufficient_quota|free-models-per-day|demasiadas peticiones)/i.test(
    low
  );
}

function findNextFreeModel(providerId, excludeUids = []) {
  const excluded = new Set(excludeUids);
  const candidates = state.models.filter(
    (m) =>
      m.provider === providerId &&
      m.category === "code" &&
      m.free &&
      !excluded.has(m.uid) &&
      !isModelDownloadable(m)
  );
  if (!candidates.length) return null;
  const currentGroup = state.selected ? modelGroupId(state.selected) : null;
  const sameGroup = currentGroup
    ? candidates.filter((m) => modelGroupId(m) === currentGroup)
    : [];
  const pool = sortFreeModels(sameGroup.length ? sameGroup : candidates);
  return pool[0] || null;
}

async function sendChat(retryCtx = null) {
  if (state.busy) return;
  const model = state.selected;
  const isRetry = Boolean(retryCtx);
  const text = isRetry ? retryCtx.text : $("prompt").value.trim();
  if (!model) { toast("Elige un modelo primero.", "error"); return; }
  if (!text) return;
  if (!isRetry) {
    state.messages.push({ role: "user", content: text });
    addMessage("user", text);
    $("prompt").value = "";
    $("prompt").style.height = "auto";
    updateConvContext();
  }

  const tried = isRetry ? [...retryCtx.tried] : [model.uid];
  const attempts = isRetry ? retryCtx.attempts : 0;

  const assistant = addMessage("assistant", "");
  const body = assistant.querySelector(".msg-body");
  body.innerHTML = `<span class="cursor"></span>`;
  let answer = "";
  let streamErrorMsg = "";
  state.busy = true;
  state.controller = new AbortController();
  $("btn-send").disabled = true;
  $("btn-stop").hidden = false;
  $("chat-status").textContent = isRetry ? `Reintentando con ${model.name}…` : "Pensando…";

  try {
    const project = state.project;
    const res = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stateless: true,
        provider: model.provider,
        uid: model.uid,
        category: model.category,
        model_context: model.context || null,
        client_auth: getClientAuth(model.provider),
        project: project,
        use_tools: $("use-tools").checked && !!project,
        messages: state.messages,
      }),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Error ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const cursor = () => `<span class="cursor"></span>`;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let event;
          try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (event.type === "delta") {
            answer += event.text;
            body.innerHTML = markdown(answer) + cursor();
            $("messages").scrollTop = $("messages").scrollHeight;
          } else if (event.type === "tool") {
            addMessage("tool", `${event.status === "error" ? "⚠" : event.status === "done" ? "✓" : "⚙"} ${event.name} · ${event.detail || ""}`);
          } else if (event.type === "system") {
            addMessage("system", event.message);
          } else if (event.type === "done") {
            const localStats = recordLocalUsage(model.provider, model.uid, event.usage || {});
            const uText = describeLocalUsage(localStats);
            $("chat-status").textContent = `Listo en ${event.elapsed}s · ${uText}`;
            updateConvContext(event.context);
            loadUsage(true);
            loadFiles();
          } else if (event.type === "error") {
            streamErrorMsg = String(event.message || "Error al responder.");
          }
        }
      }
    }
    if (streamErrorMsg && !answer.trim()) {
      throw new Error(streamErrorMsg);
    }
    if (answer.trim()) {
      state.messages.push({ role: "assistant", content: answer });
      assistant.dataset.raw = answer;
      body.innerHTML = markdown(answer);
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.innerHTML = `<button type="button" class="msg-copy-btn" data-copy-msg>Copiar</button>`;
      assistant.appendChild(actions);
    } else {
      assistant.remove();
    }
    if (streamErrorMsg && answer.trim()) {
      addMessage("error", streamErrorMsg);
    }
  } catch (exc) {
    if (exc.name !== "AbortError") {
      if (!answer.trim()) assistant.remove();
      const errMsg = exc.message || "Error inesperado.";
      const autoEnabled = Boolean($("auto-switch-free") ? $("auto-switch-free").checked : state.autoSwitchFree);
      if (!answer.trim() && autoEnabled && isQuotaOrLimitError(errMsg) && attempts < 3) {
        const nextModel = findNextFreeModel(model.provider, tried);
        if (nextModel) {
          addMessage(
            "system",
            `↻ ${model.name} alcanzó el límite de consumo. Cambiando automáticamente a ${nextModel.name}…`
          );
          toast(`Cambiado automáticamente a ${nextModel.name} (gratis)`, "ok");
          selectModel(nextModel, false);
          state.busy = false;
          state.controller = null;
          $("btn-send").disabled = false;
          $("btn-stop").hidden = true;
          await sendChat({ text, tried: [...tried, nextModel.uid], attempts: attempts + 1 });
          return;
        }
        addMessage(
          "system",
          `⚠ ${model.name} alcanzó el límite y no quedan más modelos gratuitos en ${model.provider_name}.`
        );
      }
      addMessage("error", errMsg);
      $("chat-status").textContent = "";
    } else {
      if (answer.trim()) {
        state.messages.push({ role: "assistant", content: answer });
        assistant.dataset.raw = answer;
        body.innerHTML = markdown(answer);
      } else {
        assistant.remove();
      }
      $("chat-status").textContent = "Detenido.";
    }
  } finally {
    state.busy = false;
    state.controller = null;
    $("btn-send").disabled = false;
    $("btn-stop").hidden = true;
    await saveConversation();
    renderModels();
    loadUsage();
  }
}

/* ------------------------------------------------------------------ imagen y vídeo */

async function generate() {
  const model = state.selected;
  if (!model || state.generating) return;
  const prompt = $("gen-prompt").value.trim();
  if (!prompt) { toast("Describe lo que quieres generar.", "error"); return; }
  state.generating = true;
  state.controller = new AbortController();
  $("btn-generate").disabled = true;
  $("btn-gen-cancel").hidden = false;
  $("gen-result").innerHTML = `<span class="gen-note">Generando… esto puede tardar unos segundos.</span>`;
  try {
    const payload = {
      stateless: true,
      provider: model.provider,
      uid: model.uid,
      prompt,
      aspect_ratio: $("gen-aspect").value || null,
      client_auth: getClientAuth(model.provider),
    };
    let data;
    if (model.category === "video") {
      payload.duration = $("gen-duration").value ? Number($("gen-duration").value) : null;
      payload.resolution = $("gen-resolution").value || null;
      data = await api("/api/video", { method: "POST", body: payload, signal: state.controller.signal });
      recordLocalUsage(model.provider, model.uid, data.usage || { videos: 1 });
    } else {
      data = await api("/api/image", { method: "POST", body: payload, signal: state.controller.signal });
      recordLocalUsage(model.provider, model.uid, data.usage || { images: 1, cost: data.cost || 0 });
    }
    const note = data.cost ? ` · coste $${Number(data.cost).toFixed(6)}` : "";
    $("gen-result").innerHTML =
      (model.category === "video"
        ? `<video controls autoplay src="${esc(data.url)}"></video>`
        : `<img src="${esc(data.url)}" alt="Imagen generada">`) +
      `<div class="gen-note">Generado${note}</div>`;
    loadUsage();
  } catch (exc) {
    if (exc.name === "AbortError") {
      $("gen-result").innerHTML = `<span class="gen-note">Generación cancelada.</span>`;
    } else {
      $("gen-result").innerHTML = `<span class="gen-note" style="color:var(--red)">${esc(exc.message)}</span>`;
    }
  } finally {
    state.generating = false;
    state.controller = null;
    $("btn-generate").disabled = false;
    $("btn-gen-cancel").hidden = true;
  }
}

/* ------------------------------------------------------------------ proyectos y archivos */

function renderProjectChip() {
  const active = (state.projects || []).find((item) => item.active);
  const label = active ? (active.root ? "Todos los proyectos" : active.name) : "Proyecto";
  $("btn-project").textContent = label;
}

function applyProjects(projects) {
  if (!Array.isArray(projects)) return;
  state.projects = projects;
  const active = projects.find((item) => item.active);
  state.project = active ? active.id : "";
  renderProjectChip();
}

function openProjects() {
  const rows = (state.projects || []).map((item) => `
    <tr>
      <td>${esc(item.name)}${item.outside ? ' <small class="usage-dim">(fuera de proyectos)</small>' : ""}</td>
      <td>${esc((item.kinds || []).join(", ") || "carpeta")}</td>
      <td>${item.count}</td>
      <td class="user-actions">
        ${item.active ? '<span class="usage-dim">actual</span>' : `<button class="btn ghost mini" data-select="${esc(item.id)}">Usar</button>`}
      </td>
    </tr>`).join("");
  const canOpen = state.user.role === "admin" || state.user.desktop;
  openModal(`
    <div class="modal-head"><h2>Proyectos</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
    <section>
      <p class="hint">Si tu cuenta está vinculada a la app de escritorio, aquí aparecen las mismas carpetas y la misma carpeta abierta.</p>
      <div class="table-wrap">
        <table class="user-table"><thead><tr><th>Proyecto</th><th>Tipo</th><th>Elementos</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">Todavía no hay proyectos.</td></tr>'}</tbody></table>
      </div>
      <div class="modal-row">
        <input id="new-project" type="text" placeholder="Nombre del proyecto nuevo">
        <button id="btn-create-project" class="btn primary" style="flex:0 0 auto">Crear</button>
      </div>
      ${canOpen ? `
      <div class="modal-row">
        <input id="open-path" type="text" placeholder="Abrir otra carpeta (ruta completa, p. ej. C:\\Proyectos\\Mi carpeta)">
        <button id="btn-open-path" class="btn ghost" style="flex:0 0 auto">Abrir</button>
      </div>` : ""}
      <div class="modal-actions">
        <button class="btn ghost" id="btn-no-project">Sin proyecto</button>
      </div>
    </section>`);
  $("modal-root").querySelector("[data-close]").addEventListener("click", closeModal);
  $("modal-root").querySelectorAll("[data-select]").forEach((button) => {
    button.addEventListener("click", async () => {
      await chooseProject(button.dataset.select);
      closeModal();
    });
  });
  $("btn-no-project").addEventListener("click", async () => {
    await chooseProject("");
    closeModal();
  });
  $("btn-create-project").addEventListener("click", async () => {
    const name = $("new-project").value.trim();
    if (!name) return;
    try {
      const data = await api("/api/project/create", { method: "POST", body: { name } });
      applyProjects(data.projects);
      toast("Proyecto creado.", "ok");
      await loadFiles();
      closeModal();
    } catch (exc) { toast(exc.message, "error"); }
  });
  if (canOpen) {
    $("btn-open-path").addEventListener("click", async () => {
      const path = $("open-path").value.trim();
      if (!path) return;
      try {
        const data = await api("/api/project/select", { method: "POST", body: { path } });
        applyProjects(data.projects);
        state.filePath = "";
        localStorage.setItem("aihub.project", state.project);
        await loadFiles();
        toast(`Carpeta: ${data.name}`, "ok");
        closeModal();
      } catch (exc) { toast(exc.message, "error"); }
    });
  }
}

async function chooseProject(id) {
  try {
    const data = await api("/api/project/select", { method: "POST", body: { name: id } });
    applyProjects(data.projects);
    state.filePath = "";
    localStorage.setItem("aihub.project", state.project);
    await loadFiles();
    toast(data.workdir ? `Proyecto: ${data.name}` : "Sin proyecto.", "ok");
  } catch (exc) {
    toast(exc.message, "error");
  }
}

async function loadFiles() {
  const list = $("file-list");
  if (!state.project) {
    list.innerHTML = `<small class="usage-dim">Elige un proyecto para ver sus archivos.</small>`;
    $("files-project").textContent = "Sin proyecto";
    $("btn-file-up").hidden = true;
    return;
  }
  try {
    const data = await api(`/api/files?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(state.filePath)}`);
    const entries = data.entries || [];
    $("files-project").textContent = state.filePath ? `Carpeta: ${state.filePath}` : "Raíz del proyecto";
    $("btn-file-up").hidden = !state.filePath;
    if (!entries.length) {
      list.innerHTML = `<small class="usage-dim">Carpeta vacía.</small>`;
      return;
    }
    list.innerHTML = entries.map((item) => `
      <div class="file-row" data-path="${esc(item.path)}" data-dir="${item.dir ? "1" : "0"}">
        <span>${item.dir ? "📁" : "📄"}</span>
        <span class="file-name">${esc(item.name)}</span>
        <small>${item.dir ? "carpeta" : fmtSize(item.size)}</small>
      </div>`).join("");
  } catch (exc) {
    list.innerHTML = `<small class="usage-dim">${esc(exc.message)}</small>`;
  }
}

$("file-list")?.addEventListener?.("click", async (event) => {
  const row = event.target.closest(".file-row");
  if (!row || !state.project) return;
  if (row.dataset.dir === "1") {
    state.filePath = row.dataset.path;
    await loadFiles();
    return;
  }
  try {
    const data = await api(`/api/file?project=${encodeURIComponent(state.project)}&path=${encodeURIComponent(row.dataset.path)}`);
    openModal(`
      <div class="modal-head">
        <h2>${esc(data.path)}</h2>
        <div class="user-actions">
          <button class="btn ghost small" id="btn-copy-file">Copiar</button>
          <button class="icon-btn" data-close>Cerrar ✕</button>
        </div>
      </div>
      <section class="file-viewer"><pre>${esc(data.text)}</pre></section>`);
    $("btn-copy-file")?.addEventListener("click", () => copyText(data.text));
  } catch (exc) {
    toast(exc.message, "error");
  }
});

/* ------------------------------------------------------------------ ajustes y usuarios */

function formatCodeStatus(item) {
  if (item.revoked) return `<span class="code-status revoked">Revocado</span>`;
  if (item.expired) return `<span class="code-status revoked">Caducado</span>`;
  if (item.exhausted) return `<span class="code-status used">Usado (${item.uses}/${item.max_uses})</span>`;
  return `<span class="code-status active">Activo</span>`;
}

function formatCodePack(item) {
  if (!item.has_pack) return `<span class="usage-dim">—</span>`;
  const parts = [];
  if (item.pack_providers > 0) parts.push(`${item.pack_providers} prov.`);
  if (item.pack_has_keys) parts.push("claves");
  return `<span class="tag">${esc(parts.join(" + ") || "paquete")}</span>`;
}

function openCodeRevealModal(code, record) {
  const url = window.location.origin;
  const inviteText = `Hola ${record.label}, te invito a usar AI Hub:\n\n1. Abre: ${url}\n2. Introduce tu código personal: ${code}\n\nTus claves, proveedores e historial se guardarán solo en tu propio equipo.`;
  openModal(`
    <div class="modal-head">
      <h2>🔑 Código creado para ${esc(record.label)}</h2>
      <button class="icon-btn" data-close>Cerrar ✕</button>
    </div>
    <div class="code-reveal">
      <div class="usage-dim">Copia y envía este código ahora. Por seguridad no se volverá a mostrar completo.</div>
      <div class="code-reveal-value">${esc(code)}</div>
      <div class="modal-row" style="margin:0">
        <button id="btn-copy-raw-code" class="btn primary small">📋 Copiar código</button>
        <button id="btn-copy-invite-msg" class="btn ghost small">💬 Copiar mensaje de invitación</button>
        <button id="btn-back-to-codes" class="btn ghost small">Volver a Accesos</button>
      </div>
    </div>
    <p class="hint" style="margin-top:12px">Cuando ${esc(record.label)} introduzca este código, entrará directamente sin usuario ni contraseña. Puedes revocarlo en cualquier momento desde <strong>🔑 Accesos</strong> y su sesión se cerrará al instante.</p>
  `);
  $("btn-copy-raw-code")?.addEventListener("click", () => copyText(code));
  $("btn-copy-invite-msg")?.addEventListener("click", () => copyText(inviteText));
  $("btn-back-to-codes")?.addEventListener("click", () => openSettings("admin"));
}

async function openSettings(tab = "main") {
  let users = [];
  let codes = [];
  let githubSyncStatus = null;
  try {
    if (state.user.role === "admin") {
      const [usersRes, codesRes, syncRes] = await Promise.all([
        api("/api/admin/users"),
        api("/api/admin/codes"),
        api("/api/admin/github-sync").catch(() => null),
      ]);
      users = usersRes.users || [];
      codes = codesRes.codes || [];
      githubSyncStatus = syncRes;
    }
  } catch (exc) {
    toast(exc.message, "error");
    return;
  }
  const vault = state.vault || defaultVault();
  const customProviders = vault.custom_providers || [];
  const presets = state.presets || (state.settings && state.settings.presets) || [];
  const cachedCount = state.models.length;
  const histCount = (vault.history && vault.history.items ? vault.history.items.length : 0);
  const favCount = (vault.favorite_models || []).length;
  const isCodeSession = String(state.user.id || "").startsWith("code-");

  const providerRows = customProviders.map((item) => {
    const isOr = String(item.base || "").toLowerCase().includes("openrouter.ai");
    return `
    <tr>
      <td><span style="color:${esc(item.color)}">${esc(item.glyph)}</span> ${esc(item.name)}</td>
      <td>${esc(item.base)}</td>
      <td>${item.key ? "guardada en tu disco" : "sin clave"}</td>
      <td class="user-actions">
        ${isOr ? `<button class="btn ghost mini" data-check-openrouter="${esc(item.id)}">Comprobar</button>` : ""}
        <button class="btn ghost mini" data-edit-provider="${esc(item.id)}">Editar</button>
        <button class="btn danger mini" data-delete-provider="${esc(item.id)}">Quitar</button>
      </td>
    </tr>`;
  }).join("");

  const codeRows = codes.map((item) => {
    const usesText = item.max_uses > 0 ? `${item.uses}/${item.max_uses}` : `${item.uses}/∞`;
    const expText = item.expires_at ? new Date(item.expires_at * 1000).toLocaleDateString("es-ES") : "—";
    return `
    <tr>
      <td><strong>${esc(item.label)}</strong>${item.role === "admin" ? ' <span class="tag">admin</span>' : ""}</td>
      <td><code>${esc(item.hint)}</code></td>
      <td>${esc(usesText)}</td>
      <td>${formatCodePack(item)}</td>
      <td>${formatCodeStatus(item)}${item.expires_at ? `<div class="usage-dim" style="font-size:11px">hasta ${esc(expText)}</div>` : ""}</td>
      <td class="user-actions">
        ${item.revoked ? "" : `<button class="btn ghost mini" data-revoke-code="${esc(item.id)}">Revocar</button>`}
        <button class="btn danger mini" data-delete-code="${esc(item.id)}">Borrar</button>
      </td>
    </tr>`;
  }).join("");

  const packProviderInputs = customProviders.map((p) => `
    <div class="code-pack-row">
      <label><span style="color:${esc(p.color)}">${esc(p.glyph)}</span> ${esc(p.name)}</label>
      <input type="password" data-pack-provider-key="${esc(p.id)}" placeholder="Clave dedicada para esta persona (opcional)" autocomplete="off">
    </div>`).join("");

  const userRows = users.map((item) => `
    <tr>
      <td>${esc(item.name)}</td><td>${esc(item.id)}</td><td>${esc(item.role)}</td>
      <td>${item.desktop ? '<span class="tag">escritorio</span>' : '<span class="usage-dim">propia</span>'}
        ${item.data_dir ? `<div class="usage-dim data-path">${esc(item.data_dir)}</div>` : ""}</td>
      <td class="user-actions">
        <button class="btn ghost mini" data-user-data="${esc(item.id)}" data-dir="${esc(item.data_dir || "")}">Datos</button>
        <button class="btn ghost mini" data-reset-user="${esc(item.id)}">Contraseña</button>
        ${item.id === state.user.id ? "" : `<button class="btn danger mini" data-delete-user="${esc(item.id)}">Borrar</button>`}
      </td>
    </tr>`).join("");
  const diskBadge = state.vaultFileName
    ? state.vaultDiskSynced
      ? `<span class="vault-badge">● Sincronizado con ${esc(state.vaultFileName)}</span>`
      : `<span class="vault-badge warn">● Archivo vinculado (${esc(state.vaultFileName)}) · pulsa Guardar para reactivar permiso</span>`
    : state.vaultServerSynced
      ? `<span class="vault-badge">● Sincronizado entre PC y móvil</span>`
      : `<span class="vault-badge">● Guardado en tu disco duro local</span>`;

  openModal(`
    <div class="modal-head"><h2>Ajustes</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
    <section id="settings-vault">
      <h3>MIS DATOS Y SINCRONIZACIÓN</h3>
      <div class="vault-box">
        <div class="vault-head">
          <div>
            <strong>Tus proveedores, claves, modelos e historial se sincronizan entre tus dispositivos (PC y móvil) en tu propio servidor</strong>
            <div class="vault-meta">${customProviders.length} proveedor${customProviders.length === 1 ? "" : "es"} añadido${customProviders.length === 1 ? "" : "s"} · ${cachedCount} modelos en caché · ${histCount} conversacion${histCount === 1 ? "" : "es"} · ${favCount} favoritos</div>
          </div>
          ${diskBadge}
        </div>
        <div class="vault-actions">
          <button id="btn-vault-sync-now" class="btn primary small">🔄 Sincronizar dispositivos ahora</button>
          ${supportsDiskFileSync() ? `
            <button id="btn-vault-link" class="btn ghost small">📁 ${state.vaultFileName ? "Cambiar archivo en disco" : "Vincular archivo en mi disco"}</button>
            <button id="btn-vault-open" class="btn ghost small">📂 Abrir archivo del disco</button>
          ` : ""}
          <button id="btn-vault-export" class="btn ghost small">⬇ Exportar copia (.json)</button>
          <button id="btn-vault-import" class="btn ghost small">⬆ Importar copia (.json)</button>
          ${state.vaultLegacyOnServer ? `<button id="btn-vault-wipe-server" class="btn danger small">🗑 Borrar copia antigua del servidor</button>` : ""}
        </div>
        <p class="hint" style="margin:0">Al iniciar sesión con el mismo usuario desde el móvil u otro navegador, tus proveedores y modelos se sincronizan automáticamente. También puedes exportar o vincular una copia local (.json).</p>
      </div>
    </section>
    <section id="settings-main">
      <h3>PROVEEDORES</h3>
      <p class="hint">Todos los proveedores se añaden aquí (OpenRouter, Ollama, OpenCode, OpenAI, Gemini, Groq, DeepSeek, Mistral, Together, LM Studio o cualquier API compatible con OpenAI) y se guardan solo en tu disco duro.</p>
      <div class="table-wrap">
        <table class="user-table"><thead><tr><th>Nombre</th><th>URL</th><th>Clave</th><th></th></tr></thead>
        <tbody>${providerRows || '<tr><td colspan="4">Sin proveedores añadidos. Elige uno abajo para empezar.</td></tr>'}</tbody></table>
      </div>
      <div class="modal-row">
        <select id="preset" class="select">
          ${presets.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join("")}
        </select>
        <input id="custom-name" type="text" placeholder="Nombre">
        <input id="custom-base" type="text" placeholder="URL base (p. ej. https://openrouter.ai/api/v1)">
        <input id="custom-key" type="password" placeholder="Clave (vacío si es local)" autocomplete="off">
      </div>
      <p id="preset-help" class="hint"></p>
      <div class="modal-row">
        <label class="check"><input type="checkbox" id="cat-code" checked> Programación</label>
        <label class="check"><input type="checkbox" id="cat-media"> Imagen y vídeo</label>
        <button id="btn-add-provider" class="btn primary" style="flex:0 0 auto">Añadir y leer modelos</button>
      </div>
    </section>
    <section>
      <h3>MI CUENTA</h3>
      <div class="account-data">
        <div>
          <strong>Sesión de acceso</strong>
          <div class="usage-dim">${esc(state.user.name)} (${isCodeSession ? "código personal" : esc(state.user.id)})</div>
        </div>
        <div class="user-actions">
          <button id="btn-clear-usage" class="btn ghost small">Reiniciar consumo local</button>
        </div>
      </div>
      ${isCodeSession ? `<p class="hint" style="margin-top:8px">Entraste con un código personal sin contraseña. Si necesitas cambiar o renovar tu acceso, pídeselo al administrador.</p>` : `
      <div class="modal-row">
        <input id="pw-current" type="password" placeholder="Código maestro / contraseña actual" autocomplete="off">
        <input id="pw-new" type="password" placeholder="Nuevo código maestro (mínimo 6)" autocomplete="off">
        <button id="btn-change-password" class="btn primary" style="flex:0 0 auto">Cambiar</button>
      </div>`}
    </section>
    ${state.user.role === "admin" ? `
    <section id="settings-admin">
      <h3>🔑 CÓDIGOS DE ACCESO (INVITACIONES PERSONALES)</h3>
      <p class="hint">Crea un código personal para cada persona que quieras autorizar. Entrarán directamente sin usuario ni contraseña y podrás revocar su acceso al instante en cualquier momento.</p>
      <div class="table-wrap">
        <table class="user-table"><thead><tr><th>Persona</th><th>Código</th><th>Usos</th><th>Paquete</th><th>Estado</th><th></th></tr></thead>
        <tbody>${codeRows || '<tr><td colspan="6">Todavía no has creado ningún código de invitación.</td></tr>'}</tbody></table>
      </div>
      <div class="modal-row">
        <input id="new-code-label" type="text" placeholder="Nombre de la persona (ej. Ana)">
        <select id="new-code-uses" class="select" style="flex:0 0 auto">
          <option value="1" selected>1 dispositivo (un solo uso)</option>
          <option value="2">Hasta 2 dispositivos</option>
          <option value="3">Hasta 3 dispositivos</option>
          <option value="5">Hasta 5 dispositivos</option>
          <option value="0">Sin límite de dispositivos</option>
        </select>
        <select id="new-code-days" class="select" style="flex:0 0 auto">
          <option value="">Sin caducidad</option>
          <option value="7">Caduca en 7 días</option>
          <option value="30">Caduca en 30 días</option>
          <option value="90">Caduca en 90 días</option>
          <option value="365">Caduca en 1 año</option>
        </select>
        <label class="check" style="flex:0 0 auto"><input type="checkbox" id="new-code-admin"> Admin</label>
      </div>
      <div class="code-pack-box">
        <label class="check">
          <input type="checkbox" id="new-code-include-providers" ${customProviders.length ? "checked" : ""}>
          <span><strong>Incluir mi lista de proveedores (${customProviders.length})</strong> para que vea los mismos proveedores y modelos al entrar (tus claves personales NO se copian)</span>
        </label>
        ${packProviderInputs || '<p class="hint" style="margin:0">Añade primero tus proveedores arriba si quieres incluirlos en el paquete inicial.</p>'}
        <p class="hint" style="margin:0">Las claves dedicadas que escribas aquí se transferirán una sola vez al disco duro de esa persona cuando canjee su código y después se borrarán del servidor.</p>
      </div>
      <div class="modal-row" style="margin-top:10px">
        <button id="btn-create-code" class="btn primary">🔑 Generar código de acceso</button>
      </div>

      <div class="vault-box" style="margin-top:18px">
        <div class="vault-head">
          <div>
            <strong>🔄 Sincronización automática GitHub → carpeta del servidor</strong>
            <div class="vault-meta">
              Destino: <code>${esc(githubSyncStatus?.target_dir || "C:\\Proyectos\\AI_Hub_Aistudio")}</code>
              · Utilidad: <code>${esc(githubSyncStatus?.utility || "robocopy")}</code>
              · Rama: <code>${esc(githubSyncStatus?.branch || "main")}</code>
            </div>
          </div>
          <span class="vault-badge ${githubSyncStatus?.last_run && !githubSyncStatus.last_run.ok ? "warn" : ""}">
            ${githubSyncStatus?.running
              ? "● Sincronizando…"
              : githubSyncStatus?.last_run
                ? githubSyncStatus.last_run.ok
                  ? `● ${esc(githubSyncStatus.last_run.commit || "OK")} · ${esc(githubSyncStatus.last_run.summary)}`
                  : `● ${esc(githubSyncStatus.last_run.summary)}`
                : githubSyncStatus?.auto_sync_enabled
                  ? `● Automática cada ${esc(String(githubSyncStatus.interval_seconds || 60))}s`
                  : "● Lista"}
          </span>
        </div>
        ${githubSyncStatus?.last_run?.error ? `<p class="hint" style="margin:0;color:var(--warn)">${esc(githubSyncStatus.last_run.error)}</p>` : ""}
        <div class="vault-actions" style="align-items:center">
          <button id="btn-github-sync-now" class="btn primary small" ${githubSyncStatus?.running ? "disabled" : ""}>🔄 Sincronizar GitHub → carpeta ahora</button>
          <label class="check" style="margin:0">
            <input type="checkbox" id="chk-github-auto-sync" ${githubSyncStatus?.auto_sync_enabled ? "checked" : ""} ${githubSyncStatus && !githubSyncStatus.supported_on_host ? "disabled" : ""}>
            <span>Comprobar cada ${esc(String(githubSyncStatus?.interval_seconds || 60))} s automáticamente</span>
          </label>
        </div>
        <p class="hint" style="margin:0">Descarga los últimos cambios de GitHub y copia los archivos automáticamente con <code>robocopy</code> (en Windows) o <code>rsync</code> (en Linux/macOS) excluyendo <code>.env</code>, <code>.git</code>, <code>node_modules</code> y datos locales.</p>
      </div>

      <details style="margin-top:18px">
        <summary class="hint" style="cursor:pointer;font-weight:600">Cuentas clásicas con usuario y contraseña (${users.length})</summary>
        <div class="table-wrap" style="margin-top:8px">
          <table class="user-table"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Datos</th><th></th></tr></thead>
          <tbody>${userRows || '<tr><td colspan="5">Sin usuarios.</td></tr>'}</tbody></table>
        </div>
        <div class="modal-row">
          <input id="new-user-name" type="text" placeholder="Nombre">
          <input id="new-user-id" type="text" placeholder="Usuario (para entrar)">
          <input id="new-user-password" type="password" placeholder="Contraseña" autocomplete="off">
          <label class="check" style="flex:0 0 auto"><input type="checkbox" id="new-user-admin"> Admin</label>
          <button id="btn-add-user" class="btn ghost" style="flex:0 0 auto">Crear</button>
        </div>
      </details>
    </section>` : ""}
  `);
  if (tab === "admin") $("settings-admin")?.scrollIntoView();
  if (tab === "account") $("pw-current")?.focus();

  const root = $("modal-root");
  const syncPreset = () => {
    const presetObj = presets.find((p) => p.id === $("preset").value);
    if (!presetObj) return;
    $("custom-name").value = presetObj.id === "custom" ? "" : presetObj.name;
    $("custom-base").value = presetObj.base || "";
    $("preset-help").textContent = presetObj.help || "";
    if ($("cat-media")) $("cat-media").checked = presetObj.id === "openrouter";
  };
  $("preset").addEventListener("change", syncPreset);
  syncPreset();

  root.querySelector("#btn-vault-sync-now")?.addEventListener("click", async () => {
    const mode = await syncVaultWithServer(false);
    syncStateFromVault();
    renderProviders();
    renderModels();
    renderDetail();
    if (mode === "pulled") {
      toast("Proveedores y modelos descargados desde tu cuenta.", "ok");
    } else if (mode === "pushed") {
      toast("Proveedores y modelos subidos para sincronizar con tus otros dispositivos.", "ok");
    } else if (mode === "same") {
      await pushVaultToServerNow();
      toast("Tus dispositivos ya están sincronizados.", "ok");
    } else {
      toast("No se pudo sincronizar ahora mismo.", "error");
    }
    await openSettings("main");
  });
  root.querySelector("#btn-vault-link")?.addEventListener("click", async () => {
    const ok = await linkHardDriveFile();
    if (ok) await openSettings("main");
  });
  root.querySelector("#btn-vault-open")?.addEventListener("click", async () => {
    const ok = await openHardDriveFile();
    if (ok) await openSettings("main");
  });
  root.querySelector("#btn-vault-export")?.addEventListener("click", exportVaultBackup);
  root.querySelector("#btn-vault-import")?.addEventListener("click", async () => {
    const ok = await triggerJsonImportInput();
    if (ok) await openSettings("main");
  });
  root.querySelector("#btn-vault-wipe-server")?.addEventListener("click", async () => {
    const ok = await confirmModal(
      "Borrar copia antigua del servidor",
      "Se eliminarán config.json, cache.json y conversations.json del servidor para tu cuenta. Tus datos locales en este equipo NO se borran.",
      "Borrar del servidor",
      true
    );
    if (!ok) return;
    try {
      await api("/api/vault/wipe-server", { method: "POST", body: {} });
      state.vaultLegacyOnServer = false;
      toast("Copia antigua eliminada del servidor.", "ok");
      await openSettings("main");
    } catch (exc) { toast(exc.message, "error"); }
  });

  root.querySelector("#btn-clear-usage").addEventListener("click", async () => {
    const ok = await confirmModal(
      "Reiniciar consumo",
      "¿Poner a cero los contadores de consumo guardados en tu disco duro?",
      "Reiniciar",
      true
    );
    if (!ok) return;
    state.vault.usage = {};
    await saveUserVault();
    toast("Consumo reiniciado.", "ok");
    loadUsage();
  });
  root.querySelector("#btn-add-provider").addEventListener("click", async () => {
    const presetId = $("preset").value;
    const presetObj = presets.find((p) => p.id === presetId) || { name: "Proveedor", base: "", glyph: "◆", color: "#9aa4b2" };
    const name = $("custom-name").value.trim() || presetObj.name;
    const base = ($("custom-base").value.trim() || presetObj.base || "").replace(/\/+$/, "");
    const key = $("custom-key").value.trim();
    const categories = [$("cat-code").checked ? "code" : "", $("cat-media").checked ? "media" : ""].filter(Boolean);
    if (!categories.length) categories.push("code");
    if (!/^https?:\/\//.test(base)) {
      toast("La URL debe empezar por http:// o https://", "error");
      return;
    }
    const record = {
      id: uniqueCustomProviderId(presetId),
      name,
      base,
      key,
      glyph: presetObj.glyph || "◆",
      color: presetObj.color || "#9aa4b2",
      categories,
    };
    state.vault.custom_providers.push(record);
    await saveUserVault();
    syncStateFromVault();
    await refreshCatalog(true, [record.id]);
    await openSettings("main");
  });
  root.querySelector("#btn-change-password")?.addEventListener("click", async () => {
    try {
      await api("/api/account/password", {
        method: "POST",
        body: { current: $("pw-current").value, new: $("pw-new").value },
      });
      toast("Código maestro actualizado.", "ok");
      closeModal();
    } catch (exc) { toast(exc.message, "error"); }
  });
  root.querySelector("#btn-create-code")?.addEventListener("click", async () => {
    const label = $("new-code-label").value.trim();
    if (label.length < 2) {
      toast("Escribe el nombre de la persona (mínimo 2 caracteres).", "error");
      $("new-code-label").focus();
      return;
    }
    const maxUses = Number($("new-code-uses").value);
    const expiresDaysRaw = $("new-code-days").value;
    const role = $("new-code-admin").checked ? "admin" : "user";
    const includeProviders = $("new-code-include-providers")?.checked;

    const perProviderKeys = new Map();
    root.querySelectorAll("[data-pack-provider-key]").forEach((input) => {
      const val = input.value.trim();
      if (val) perProviderKeys.set(input.dataset.packProviderKey, val);
    });

    const packProviders = [];
    if (includeProviders || perProviderKeys.size > 0) {
      for (const p of customProviders) {
        const dedicatedKey = perProviderKeys.get(p.id) || "";
        if (!includeProviders && !dedicatedKey) continue;
        packProviders.push({
          id: p.id,
          name: p.name,
          base: p.base,
          key: dedicatedKey,
          glyph: p.glyph || "◆",
          color: p.color || "#9aa4b2",
          categories: p.categories || ["code"],
        });
      }
    }

    const bootstrapPack = packProviders.length
      ? { custom_providers: packProviders }
      : null;

    try {
      const res = await api("/api/admin/codes", {
        method: "POST",
        body: {
          label,
          role,
          max_uses: maxUses,
          expires_days: expiresDaysRaw ? Number(expiresDaysRaw) : null,
          bootstrap_pack: bootstrapPack,
        },
      });
      openCodeRevealModal(res.code, res.record);
    } catch (exc) {
      toast(exc.message, "error");
    }
  });
  root.querySelector("#btn-add-user")?.addEventListener("click", async () => {
    try {
      const displayName = $("new-user-name").value.trim();
      const username = $("new-user-id").value.trim();
      await api("/api/admin/users", {
        method: "POST",
        body: {
          name: displayName || username,
          username,
          password: $("new-user-password").value,
          role: $("new-user-admin").checked ? "admin" : "user",
        },
      });
      toast("Usuario creado.", "ok");
      await openSettings("admin");
    } catch (exc) { toast(exc.message, "error"); }
  });
  root.querySelector("#btn-github-sync-now")?.addEventListener("click", async () => {
    const btn = $("btn-github-sync-now");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Sincronizando…";
    }
    try {
      const res = await api("/api/admin/github-sync", { method: "POST" });
      toast(res.run?.summary || "Sincronización completada.", "ok");
    } catch (exc) {
      toast(exc.message, "error");
    }
    await openSettings("admin");
  });
  root.querySelector("#chk-github-auto-sync")?.addEventListener("change", async (e) => {
    try {
      const enabled = Boolean(e.target.checked);
      await api("/api/admin/github-sync/config", {
        method: "POST",
        body: { enabled },
      });
      toast(enabled ? "Sincronización automática activada." : "Sincronización automática pausada.", "ok");
      await openSettings("admin");
    } catch (exc) {
      toast(exc.message, "error");
      await openSettings("admin");
    }
  });
  root.onclick = async (event) => {
    const revokeCode = event.target.closest("[data-revoke-code]");
    if (revokeCode) {
      const cid = revokeCode.dataset.revokeCode;
      const ok = await confirmModal(
        "Revocar código de acceso",
        "La persona que use este código perderá el acceso al instante en su próxima petición y el código no podrá volver a usarse.",
        "Revocar ahora",
        true
      );
      if (!ok) return;
      try {
        await api("/api/admin/codes/revoke", { method: "POST", body: { id: cid } });
        toast("Código revocado. Acceso cortado al instante.", "ok");
        await openSettings("admin");
      } catch (exc) { toast(exc.message, "error"); }
      return;
    }
    const deleteCode = event.target.closest("[data-delete-code]");
    if (deleteCode) {
      const cid = deleteCode.dataset.deleteCode;
      const ok = await confirmModal(
        "Borrar código de acceso",
        "¿Eliminar este código de la lista? Si todavía estaba activo, la persona perderá el acceso de inmediato.",
        "Borrar",
        true
      );
      if (!ok) return;
      try {
        await api("/api/admin/codes/delete", { method: "POST", body: { id: cid } });
        toast("Código borrado.", "ok");
        await openSettings("admin");
      } catch (exc) { toast(exc.message, "error"); }
      return;
    }
    const dataUser = event.target.closest("[data-user-data]");
    if (dataUser) {
      const current = dataUser.dataset.dir || "";
      const value = await promptModal(
        "Carpeta de proyectos del servidor",
        "· Vacío: carpeta propia\n· __desktop__: carpeta principal del servidor\n· O una ruta absoluta existente",
        current,
        "text",
        "Vacío, __desktop__ o ruta absoluta"
      );
      if (value === null) return;
      try {
        await api("/api/admin/users/data", {
          method: "POST",
          body: { id: dataUser.dataset.userData, data_dir: value.trim() },
        });
        toast("Carpeta actualizada.", "ok");
        if (dataUser.dataset.userData === state.user.id) location.reload();
        else await openSettings("admin");
      } catch (exc) { toast(exc.message, "error"); }
      return;
    }
    const checkOr = event.target.closest("[data-check-openrouter]");
    if (checkOr) {
      const pid = checkOr.dataset.checkOpenrouter;
      const provider = (state.vault.custom_providers || []).find((item) => item.id === pid);
      const key = String(provider?.key || "").trim();
      if (!key) {
        toast("Edita este proveedor OpenRouter y añade su clave para comprobarla.", "error");
        return;
      }
      try {
        const result = await api("/api/check", { method: "POST", body: { openrouter_api_key: key } });
        if (!result.ok) throw new Error(result.message || "Clave de OpenRouter no válida.");
        const bits = ["Clave válida"];
        if (result.free_remaining != null) bits.push(`${result.free_remaining} gratis hoy`);
        if (result.credits != null) bits.push(`créditos $${result.credits}`);
        else if (result.remaining != null) bits.push(`saldo $${result.remaining}`);
        toast(bits.join(" · "), "ok");
      } catch (exc) { toast(exc.message, "error"); }
      return;
    }
    const editProvider = event.target.closest("[data-edit-provider]");
    if (editProvider) {
      closeModal();
      await openEditProvider(editProvider.dataset.editProvider);
      return;
    }
    const deleteProvider = event.target.closest("[data-delete-provider]");
    if (deleteProvider) {
      const pid = deleteProvider.dataset.deleteProvider;
      state.vault.custom_providers = (state.vault.custom_providers || []).filter((item) => item.id !== pid);
      delete state.vault.models_by_provider[pid];
      await saveUserVault();
      syncStateFromVault();
      renderProviders();
      renderModels();
      toast("Proveedor eliminado de tu disco duro.", "ok");
      await openSettings("main");
      return;
    }
    const resetUser = event.target.closest("[data-reset-user]");
    if (resetUser) {
      const password = await promptModal(
        "Cambiar contraseña",
        "Nueva contraseña para " + resetUser.dataset.resetUser + " (mínimo 6 caracteres):",
        "",
        "password",
        "Mínimo 6 caracteres"
      );
      if (!password) return;
      try {
        await api("/api/admin/users/password", { method: "POST", body: { id: resetUser.dataset.resetUser, password } });
        toast("Contraseña actualizada.", "ok");
      } catch (exc) { toast(exc.message, "error"); }
      return;
    }
    const deleteUser = event.target.closest("[data-delete-user]");
    if (deleteUser) {
      const ok = await confirmModal(
        "Borrar usuario",
        "¿Borrar este usuario de acceso? Los datos locales en el disco de cada usuario no se ven afectados.",
        "Borrar",
        true
      );
      if (!ok) return;
      try {
        await api("/api/admin/users/delete", { method: "POST", body: { id: deleteUser.dataset.deleteUser } });
        await openSettings("admin");
      } catch (exc) { toast(exc.message, "error"); }
    }
  };
}

async function openEditProvider(id) {
  const provider = ((state.vault && state.vault.custom_providers) || []).find((item) => item.id === id);
  if (!provider) { toast("Proveedor no encontrado.", "error"); return; }
  openModal(`
    <div class="modal-head"><h2>Editar proveedor</h2><button class="icon-btn" data-close>Cerrar ✕</button></div>
    <section>
      <div class="modal-row">
        <input id="edit-name" type="text" value="${esc(provider.name)}" placeholder="Nombre">
        <input id="edit-base" type="text" value="${esc(provider.base)}" placeholder="URL base">
        <input id="edit-key" type="password" placeholder="Nueva clave (vacío = no cambiar)" autocomplete="off">
      </div>
      <div class="modal-row">
        <label class="check"><input type="checkbox" id="edit-cat-code" ${(provider.categories || []).includes("code") ? "checked" : ""}> Programación</label>
        <label class="check"><input type="checkbox" id="edit-cat-media" ${(provider.categories || []).includes("media") ? "checked" : ""}> Imagen y vídeo</label>
        <button id="btn-save-provider" class="btn primary" style="flex:0 0 auto">Guardar y leer modelos</button>
      </div>
    </section>`);
  document.querySelector("#modal-root [data-close]").addEventListener("click", closeModal);
  document.querySelector("#btn-save-provider").addEventListener("click", async () => {
    const name = document.querySelector("#edit-name").value.trim();
    const base = document.querySelector("#edit-base").value.trim().replace(/\/+$/, "");
    const key = document.querySelector("#edit-key").value.trim();
    if (!/^https?:\/\//.test(base)) {
      toast("La URL debe empezar por http:// o https://", "error");
      return;
    }
    if (name) provider.name = name;
    provider.base = base;
    if (key) provider.key = key;
    const cats = [
      document.querySelector("#edit-cat-code").checked ? "code" : "",
      document.querySelector("#edit-cat-media").checked ? "media" : "",
    ].filter(Boolean);
    provider.categories = cats.length ? cats : ["code"];
    await saveUserVault();
    syncStateFromVault();
    closeModal();
    await refreshCatalog(true, [provider.id]);
    await openSettings("main");
  });
}

/* ------------------------------------------------------------------ sesión */

async function logout() {
  try { await api("/api/logout", { method: "POST", body: {} }); } catch {}
  localStorage.removeItem("aihub.model");
  localStorage.removeItem("aihub.conversation");
  localStorage.removeItem("aihub.project");
  location.reload();
}

/* ------------------------------------------------------------------ arranque */

document.addEventListener("DOMContentLoaded", () => {
  $("code-view")?.addEventListener("submit", (event) => {
    event.preventDefault();
    doAuth("/api/access/redeem", { code: $("access-code-input").value });
  });
  $("btn-toggle-classic")?.addEventListener("click", () => showLogin("classic"));
  $("btn-toggle-code")?.addEventListener("click", () => showLogin("code"));
  $("login-view").addEventListener("submit", (event) => {
    event.preventDefault();
    doAuth("/api/login", { name: $("login-name").value, password: $("login-password").value });
  });
  $("setup-view").addEventListener("submit", (event) => {
    event.preventDefault();
    doAuth("/api/setup", { name: $("setup-name").value, password: $("setup-password").value });
  });
  boot();
});
