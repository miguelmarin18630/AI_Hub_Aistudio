import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import * as access from "./src/access.ts";
import * as agent from "./src/agent.ts";
import * as api from "./src/api.ts";
import * as catalog from "./src/catalog.ts";
import * as chat from "./src/chat.ts";
import * as config from "./src/config.ts";
import * as custom from "./src/custom.ts";
import * as projects from "./src/projects.ts";
import * as githubSync from "./src/sync.ts";
import { APP_VERSION } from "./src/types.ts";
import type {
  ChatMessage,
  ConversationRecord,
  ConversationStore,
  CustomProviderRecord,
  ModelPayload,
  ProjectInfo,
  ProviderInfo,
  UserConfig,
  UserRecord,
} from "./src/types.ts";
import * as usage from "./src/usage.ts";
import * as users from "./src/users.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "public");
const MAX_HISTORY = 40;
const TOOL_ROUNDS = 7;

const loginAttempts = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now() / 1000;
  const stamps = (loginAttempts.get(ip) || []).filter((s) => now - s < 900);
  loginAttempts.set(ip, stamps);
  return stamps.length >= 8;
}

function noteFailure(ip: string): void {
  const stamps = loginAttempts.get(ip) || [];
  stamps.push(Date.now() / 1000);
  loginAttempts.set(ip, stamps);
}

function clearFailures(ip: string): void {
  loginAttempts.delete(ip);
}

function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf) return cf;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "127.0.0.1";
}

function isSecureRequest(req: Request): boolean {
  const proto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  const cfVisitor = String(req.headers["cf-visitor"] || "");
  return req.secure || proto === "https" || cfVisitor.includes('"https"');
}

function originOk(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    if (!host) return true;
    return originHost === host;
  } catch {
    return false;
  }
}

function providerList(cfg: UserConfig): ProviderInfo[] {
  return [
    ...catalog.BASE_PROVIDERS.map((p) => ({ ...p })),
    ...custom.records(cfg).map((r) => custom.providerEntry(r)),
  ];
}

function normalizeClientProviders(raw: unknown): CustomProviderRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomProviderRecord[] = [];
  for (const item of raw.slice(0, 30)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = String(rec.id || "").trim();
    const name = String(rec.name || "").trim();
    const base = String(rec.base || "").trim().replace(/\/+$/, "");
    if (!id || !name || !/^https?:\/\//.test(base)) continue;
    const rawCats = Array.isArray(rec.categories) ? rec.categories : ["code"];
    const categories = rawCats.filter((c: unknown) => c === "code" || c === "media") as string[];
    if (!categories.length) categories.push("code");
    out.push({
      id,
      name,
      base,
      key: String(rec.key || "").trim(),
      glyph: String(rec.glyph || "◆"),
      color: String(rec.color || "#9aa4b2"),
      categories,
    });
  }
  return out;
}

function parseClientAuth(raw: unknown): { apiKey: string; base: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const apiKey = String(obj.api_key || "").trim();
  const base = String(obj.base || "").trim().replace(/\/+$/, "");
  if (base && !/^https?:\/\//.test(base)) return null;
  return { apiKey, base };
}

function allModels(cfg: UserConfig): { providers: ProviderInfo[]; models: ModelPayload[] } {
  const providers = providerList(cfg);
  const byId = new Map(providers.map((p) => [p.id, p]));
  const models: ModelPayload[] = [];
  for (const provider of providers) {
    const { models: cached, ts } = catalog.cachedModels(provider.id);
    for (const model of cached) {
      const payload = catalog.modelPayload(model, byId.get(model.provider) || provider);
      payload.cached_at = ts;
      models.push(payload);
    }
  }
  return { providers, models };
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function safeProject(cfg: UserConfig, name?: string | null): string {
  const root = projects.projectRoot(cfg);
  const raw = String(name || "").trim();
  if (!raw || raw === "__root__") return root;
  if (raw === "__current__") {
    const active = String(cfg.workdir || "").trim();
    if (!active) throw new Error("No hay una carpeta abierta.");
    const target = path.resolve(active);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error("La carpeta abierta ya no existe.");
    }
    return target;
  }
  const target = path.resolve(root, raw);
  if (!isInside(root, target)) throw new Error("Proyecto no válido.");
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    throw new Error("Ese proyecto no existe.");
  }
  return target;
}

function safeIn(base: string, relative?: string | null): string {
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, String(relative || ""));
  if (!isInside(resolvedBase, target)) throw new Error("Ruta fuera del proyecto.");
  return target;
}

function activePath(cfg: UserConfig): string | null {
  const raw = String(cfg.workdir || "").trim();
  if (!raw) return null;
  try {
    const target = path.resolve(raw);
    return fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

function projectsPayload(cfg: UserConfig): ProjectInfo[] {
  const active = activePath(cfg);
  const root = projects.projectRoot(cfg);
  const out: ProjectInfo[] = [];
  const seen = new Set<string>();
  for (const item of projects.listProjects(cfg)) {
    const resolved = path.resolve(item.path);
    seen.add(resolved);
    out.push({
      id: item.root ? "__root__" : item.name,
      name: item.root ? "Todos los proyectos" : item.name,
      kinds: item.kinds,
      count: item.count,
      mtime: item.mtime,
      root: item.root,
      active: active !== null && resolved === active,
    });
  }
  if (active && !seen.has(active)) {
    const extra = projects.describeProject(active);
    out.unshift({
      id: "__current__",
      name: path.basename(active) || active,
      kinds: extra.kinds,
      count: extra.count,
      mtime: extra.mtime,
      root: active === root,
      outside: true,
      active: true,
    });
  }
  return out;
}

function mediaBases(cfg: UserConfig, userId: string): string[] {
  const bases: string[] = [];
  try {
    bases.push(path.resolve(users.effectiveDir(userId)));
  } catch {
    // ignore
  }
  const output = String(cfg.output_root || "").trim();
  if (output) bases.push(path.resolve(output));
  return [...new Set(bases)];
}

function mediaRelative(cfg: UserConfig, userId: string, filePath: string): string {
  const target = path.resolve(filePath);
  for (const base of mediaBases(cfg, userId)) {
    if (isInside(base, target)) {
      return path.relative(base, target).split(path.sep).join("/");
    }
  }
  throw new Error("El archivo generado queda fuera de las carpetas permitidas.");
}

function conversationPath(): string {
  return path.join(config.appDir(), "conversations.json");
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .filter((p) => p && typeof p === "object" && (p as Record<string, unknown>).text)
      .map((p) => String((p as Record<string, unknown>).text))
      .join("\n");
  }
  return "";
}

function cleanMessages(raw: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(raw)) return [];
  const clean: Array<{ role: string; content: string }> = [];
  for (const item of raw.slice(-400)) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const role = String(obj.role || "");
    if (!["user", "assistant", "tool", "system"].includes(role)) continue;
    let content = obj.content;
    if (Array.isArray(content)) content = textOf(content);
    if (typeof content !== "string") continue;
    const trimmed = content.slice(0, 200_000);
    if (!trimmed.trim() && role !== "tool") continue;
    clean.push({ role, content: trimmed });
  }
  return clean;
}

function readConversations(): ConversationStore {
  try {
    const raw = JSON.parse(fs.readFileSync(conversationPath(), "utf-8"));
    const items = Array.isArray(raw?.items)
      ? raw.items.filter((i: unknown) => i && typeof i === "object").slice(0, 30)
      : [];
    const current =
      raw?.current &&
      typeof raw.current === "object" &&
      Array.isArray(raw.current.messages) &&
      raw.current.messages.length
        ? raw.current
        : null;
    return { items, current };
  } catch {
    return { items: [], current: null };
  }
}

function writeConversations(data: ConversationStore): void {
  const target = conversationPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

function buildConversationRecord(payload: Record<string, unknown>): ConversationRecord {
  const messages = cleanMessages(payload.messages);
  if (!messages.length) throw new Error("La conversación está vacía.");
  const firstUser = messages.find((m) => m.role === "user")?.content || "";
  let title = firstUser.split(/\s+/).join(" ").trim();
  if (title.length > 60) title = `${title.slice(0, 57)}…`;
  return {
    id: String(payload.id || "") || String(Date.now()),
    title: title || "Chat sin título",
    model: String(payload.model || ""),
    messages,
    updated: Date.now() / 1000,
  };
}

function historyMeta(record: ConversationRecord) {
  return {
    id: record.id,
    title: record.title || "Chat sin título",
    model: record.model || "",
    updated: record.updated || 0,
  };
}

function settingsPayload(cfg: UserConfig) {
  const key = config.openrouterKey(cfg, false);
  return {
    openrouter_set: Boolean(key),
    openrouter_hint: key ? key.slice(-4) : "",
    custom_providers: custom.records(cfg).map((item) => ({
      id: item.id,
      name: item.name,
      base: item.base,
      glyph: item.glyph,
      color: item.color,
      categories: item.categories || ["code"],
      key_set: Boolean(item.key),
    })),
    presets: custom.PRESETS,
    output_root: String(cfg.output_root || ""),
  };
}

function addUsageTotals(totals: Record<string, number>, data: Record<string, unknown>): void {
  const map: Array<[string, string[]]> = [
    ["prompt_tokens", ["prompt_tokens", "input_tokens"]],
    ["completion_tokens", ["completion_tokens", "output_tokens"]],
    ["cost", ["cost"]],
  ];
  for (const [key, names] of map) {
    const val = names.map((n) => data[n]).find((v) => v != null);
    if (val == null) continue;
    const num = Number(val);
    if (Number.isFinite(num)) {
      totals[key] = (totals[key] || 0) + num;
    }
  }
}

interface AuthedRequest extends Request {
  currentUser?: UserRecord;
  rawBody?: Buffer;
}

const app = express();
app.set("trust proxy", true);
app.use(cookieParser());
app.use(
  express.json({
    limit: "16mb",
    verify: (req, _res, buf) => {
      if (req.url === "/api/webhook/github") {
        (req as AuthedRequest).rawBody = Buffer.from(buf);
      }
    },
  })
);

// Security headers (iframe-compatible for AI Studio preview)
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  next();
});

// Origin check on POST requests (GitHub webhook uses mandatory HMAC-SHA256 instead of browser Origin)
app.use((req, res, next) => {
  if (req.method === "POST" && req.path !== "/api/webhook/github" && !originOk(req)) {
    res.status(403).json({ error: "Origen no permitido." });
    return;
  }
  next();
});

// Attach authenticated user (or personal access code) & run downstream inside isolated dir
function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[users.cookieName()];
  const parsed = users.readSessionEx(token);
  if (!parsed) {
    next();
    return;
  }
  const codeUser = access.isCodeSessionValid(parsed.subjectId, parsed.tokenVersion);
  if (codeUser) {
    try {
      const dir = users.ensureUserEnv(codeUser.id);
      req.currentUser = codeUser;
      config.runWithAppDir(dir, () => next());
    } catch (err) {
      next(err);
    }
    return;
  }
  const user = users.getUser(parsed.subjectId);
  if (!user) {
    next();
    return;
  }
  try {
    const dir = users.ensureUserEnv(user.id);
    req.currentUser = user;
    config.runWithAppDir(dir, () => next());
  } catch (err) {
    next(err);
  }
}

app.use(attachUser);

function requireUser(req: AuthedRequest, res: Response): UserRecord | null {
  if (!req.currentUser) {
    res.status(401).json({ error: "Inicia sesión para continuar." });
    return null;
  }
  return req.currentUser;
}

function requireAdmin(req: AuthedRequest, res: Response): UserRecord | null {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    res.status(403).json({ error: "Solo el administrador puede hacer esto." });
    return null;
  }
  return user;
}

// Static assets & root routes
app.get(["/", "/index.html"], (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(STATIC_DIR, "index.html"));
});

app.use(
  "/static",
  express.static(STATIC_DIR, {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store");
    },
  })
);

app.get("/manifest.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/manifest+json; charset=utf-8");
  res.sendFile(path.join(STATIC_DIR, "manifest.json"));
});

app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Service-Worker-Allowed", "/");
  res.type("application/javascript; charset=utf-8");
  res.sendFile(path.join(STATIC_DIR, "sw.js"));
});

for (const iconFile of [
  "pwa-192x192.png",
  "pwa-512x512.png",
  "pwa-maskable-512x512.png",
  "apple-touch-icon.png",
]) {
  app.get(`/${iconFile}`, (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/png");
    res.sendFile(path.join(STATIC_DIR, iconFile));
  });
}

app.get("/favicon.ico", (_req, res) => {
  res.type("image/svg+xml");
  res.sendFile(path.join(STATIC_DIR, "favicon.svg"));
});

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8").send("User-agent: *\nDisallow: /\n");
});

// Auth & state
app.get("/api/state", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ setup_required: !access.hasAnyAdmin(), auth_mode: "code", version: APP_VERSION });
});

app.get("/api/me", (req: AuthedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json({ user: users.publicUser(user) });
});

app.post("/api/setup", (req, res) => {
  if (access.hasAnyAdmin()) {
    res.status(403).json({ error: "La instalación ya está configurada." });
    return;
  }
  const user = users.createUser(
    String(req.body?.name || "admin"),
    String(req.body?.password || req.body?.code || ""),
    "admin"
  );
  res.setHeader("Set-Cookie", users.cookieHeader(user.id, isSecureRequest(req), 1));
  res.setHeader("Cache-Control", "no-store");
  res.json({ user });
});

app.post("/api/access/redeem", (req, res) => {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    return;
  }
  try {
    const result = access.redeemCode(String(req.body?.code || ""));
    if (!result) {
      noteFailure(ip);
      res.status(401).json({ error: "Código de acceso no válido." });
      return;
    }
    clearFailures(ip);
    res.setHeader("Set-Cookie", users.cookieHeader(result.subjectId, isSecureRequest(req), result.tokenVersion));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      user: result.user,
      bootstrap_pack: result.bootstrapPack,
    });
  } catch (err) {
    noteFailure(ip);
    res.status(403).json({ error: (err as Error).message });
  }
});

app.post("/api/login", (req, res) => {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Demasiados intentos. Espera unos minutos." });
    return;
  }
  const user = users.verifyUser(String(req.body?.name || ""), String(req.body?.password || ""));
  if (!user) {
    noteFailure(ip);
    res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    return;
  }
  clearFailures(ip);
  res.setHeader("Set-Cookie", users.cookieHeader(user.id, isSecureRequest(req), 1));
  res.setHeader("Cache-Control", "no-store");
  res.json({ user });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", users.clearCookieHeader(isSecureRequest(req)));
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.post("/api/account/password", (req: AuthedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!users.verifyUser(user.id, String(req.body?.current || ""))) {
    res.status(403).json({ error: "La contraseña actual no es correcta." });
    return;
  }
  users.setPassword(user.id, String(req.body?.new || ""));
  res.json({ ok: true });
});

// Catalog & refresh
app.get("/api/catalog", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const cfg = config.loadConfig();
  const { providers, models } = allModels(cfg);
  res.json({
    providers,
    base_providers: catalog.BASE_PROVIDERS.map((p) => ({ ...p })),
    presets: custom.PRESETS,
    groups: catalog.MODEL_GROUPS,
    models,
    projects: projectsPayload(cfg),
    settings: settingsPayload(cfg),
    favorites: cfg.favorite_models || [],
    version: APP_VERSION,
  });
});

app.get("/api/vault/legacy", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const cfgPath = config.configPath();
  const convPath = conversationPath();
  const hasCfgFile = fs.existsSync(cfgPath);
  const hasConvFile = fs.existsSync(convPath);
  const cfg = hasCfgFile ? config.loadConfig() : config.defaultConfig();
  const history = hasConvFile ? readConversations() : { items: [], current: null };
  const openrouterKey = config.openrouterKey(cfg, false);
  const customProviders = custom.records(cfg);
  const favorites = Array.isArray(cfg.favorite_models) ? cfg.favorite_models : [];
  const usageMap = cfg.usage && typeof cfg.usage === "object" ? cfg.usage : {};
  const hasData = Boolean(
    openrouterKey ||
      customProviders.length ||
      favorites.length ||
      Object.keys(usageMap).length ||
      history.items.length ||
      (history.current && history.current.messages.length)
  );
  res.setHeader("Cache-Control", "no-store");
  res.json({
    has_data: hasData,
    data: {
      openrouter_api_key: openrouterKey,
      custom_providers: customProviders,
      favorite_models: favorites,
      usage: usageMap,
      history,
    },
  });
});

function vaultSyncPath(): string {
  return path.join(config.appDir(), "vault.json");
}

app.get("/api/vault/sync", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  const target = vaultSyncPath();
  if (!fs.existsSync(target)) {
    res.json({ ok: true, has_vault: false, vault: null, updated_at: 0 });
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(target, "utf-8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      res.json({ ok: true, has_vault: false, vault: null, updated_at: 0 });
      return;
    }
    res.json({
      ok: true,
      has_vault: true,
      vault: raw,
      updated_at: Number(raw.updated_at || 0),
    });
  } catch {
    res.json({ ok: true, has_vault: false, vault: null, updated_at: 0 });
  }
});

app.post("/api/vault/sync", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const incoming = req.body?.vault;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    res.status(400).json({ error: "Formato de bóveda no válido." });
    return;
  }
  const serialized = JSON.stringify(incoming);
  if (serialized.length > 15 * 1024 * 1024) {
    res.status(413).json({ error: "Los datos locales superan el límite de sincronización." });
    return;
  }
  const target = vaultSyncPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, serialized, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
  res.json({ ok: true, updated_at: Number((incoming as Record<string, unknown>).updated_at || Date.now()) });
});

app.post("/api/vault/wipe-server", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const removed: string[] = [];
  for (const target of [config.configPath(), config.cachePath(), conversationPath()]) {
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(path.basename(target));
      }
    } catch {
      // ignore
    }
  }
  res.json({ ok: true, removed });
});

app.post("/api/refresh", async (req: AuthedRequest, res, next) => {
  if (!requireUser(req, res)) return;
  try {
    const stateless = Boolean(req.body?.stateless);
    const cfg = stateless ? config.defaultConfig() : config.loadConfig();
    const wanted = Array.isArray(req.body?.providers) && req.body.providers.length
      ? (req.body.providers as string[])
      : null;
    const baseIds = catalog.BASE_PROVIDERS.map((p) => p.id);
    const customRecords = stateless
      ? normalizeClientProviders(req.body?.custom_providers)
      : custom.records(cfg);
    const targets = new Set(wanted || [...baseIds, ...customRecords.map((r) => r.id)]);

    const errors: Record<string, string> = {};
    const updated: string[] = [];
    const baseTargets = baseIds.filter((id) => targets.has(id));
    const statelessModels: ModelPayload[] = [];
    const nowTs = Date.now() / 1000;
    const providersOut: ProviderInfo[] = [
      ...catalog.BASE_PROVIDERS.map((p) => ({ ...p })),
      ...customRecords.map((r) => custom.providerEntry(r)),
    ];
    const providerById = new Map(providersOut.map((p) => [p.id, p]));

    if (baseTargets.length) {
      try {
        const result = await catalog.refreshAll(cfg, baseTargets, false, !stateless);
        for (const [pid, entry] of Object.entries(result)) {
          updated.push(pid);
          if (entry.error) errors[pid] = entry.error;
          if (stateless) {
            const pInfo = providerById.get(pid);
            for (const m of entry.models) {
              const payload = catalog.modelPayload(m, pInfo);
              payload.cached_at = nowTs;
              statelessModels.push(payload);
            }
          }
        }
      } catch (err) {
        errors.__general__ = (err as Error).message;
      }
    }

    for (const record of customRecords) {
      if (!targets.has(record.id)) continue;
      try {
        const models = await custom.fetchCustomModels(record);
        if (stateless) {
          const pInfo = providerById.get(record.id) || custom.providerEntry(record);
          for (const m of models) {
            const payload = catalog.modelPayload(m, pInfo);
            payload.cached_at = nowTs;
            statelessModels.push(payload);
          }
        } else {
          catalog.storeModels(record.id, models);
        }
        updated.push(record.id);
      } catch (err) {
        errors[record.id] = (err as Error).message;
      }
    }

    if (stateless) {
      res.json({
        providers: providersOut,
        groups: catalog.MODEL_GROUPS,
        models: statelessModels,
        errors,
        updated,
        stateless: true,
      });
      return;
    }

    const { providers, models } = allModels(cfg);
    res.json({ providers, groups: catalog.MODEL_GROUPS, models, errors, updated });
  } catch (err) {
    next(err);
  }
});

app.post("/api/check", async (req: AuthedRequest, res, next) => {
  if (!requireUser(req, res)) return;
  try {
    const clientKey = String(req.body?.openrouter_api_key || "").trim();
    const key = clientKey || config.openrouterKey(config.loadConfig(), false);
    if (!key) {
      res.status(400).json({ error: "No hay clave de OpenRouter guardada." });
      return;
    }
    res.json(await api.checkOpenRouter(key));
  } catch (err) {
    next(err);
  }
});

// History
app.get("/api/history", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const wanted = String(req.query.id || "");
  const data = readConversations();
  if (wanted) {
    let record = data.items.find((i) => i.id === wanted) || null;
    if (!record && data.current?.id === wanted) record = data.current;
    if (!record) {
      res.status(404).json({ error: "Esa conversación no existe." });
      return;
    }
    res.json({ conversation: record });
    return;
  }
  res.json({ items: data.items.map(historyMeta), current: data.current });
});

app.post("/api/history/save", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const state = readConversations();
  const record = buildConversationRecord(req.body || {});
  const items = state.items.filter((i) => i.id !== record.id);
  items.unshift(record);
  writeConversations({ items: items.slice(0, 30), current: record });
  res.json({ ok: true, conversation: historyMeta(record) });
});

app.post("/api/history/open", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const wanted = String(req.body?.id || "");
  const state = readConversations();
  let record = state.items.find((i) => i.id === wanted) || null;
  if (!record && state.current?.id === wanted) record = state.current;
  if (!record) {
    res.status(400).json({ error: "Esa conversación no existe." });
    return;
  }
  state.current = record;
  writeConversations(state);
  res.json({ ok: true, conversation: record });
});

app.post("/api/history/delete", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const wanted = String(req.body?.id || "");
  const state = readConversations();
  const items = state.items.filter((i) => i.id !== wanted);
  const current = state.current?.id === wanted ? null : state.current;
  writeConversations({ items, current });
  res.json({ ok: true });
});

app.post("/api/history/new", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const state = readConversations();
  writeConversations({ items: state.items, current: null });
  res.json({ ok: true });
});

// Help
app.get("/api/help", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  res.json({ text: chat.explainText() });
});

// Projects & Files
app.get("/api/projects", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  res.json({ projects: projectsPayload(config.loadConfig()) });
});

app.post("/api/project/select", (req: AuthedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const cfg = config.loadConfig();
  const rawPath = String(req.body?.path || "").trim();
  if (rawPath) {
    if (user.role !== "admin" && !users.dataDir(user)) {
      res.status(403).json({ error: "Solo el administrador puede abrir carpetas fuera de sus proyectos." });
      return;
    }
    const target = path.resolve(rawPath);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      res.status(400).json({ error: "Esa carpeta no existe." });
      return;
    }
    config.updateConfig({ workdir: target });
    res.json({
      ok: true,
      workdir: target,
      name: path.basename(target),
      projects: projectsPayload(config.loadConfig()),
    });
    return;
  }
  const name = String(req.body?.name || "");
  if (!name) {
    config.updateConfig({ workdir: "" });
    res.json({ ok: true, workdir: "", projects: projectsPayload(config.loadConfig()) });
    return;
  }
  const target = safeProject(cfg, name);
  config.updateConfig({ workdir: target });
  res.json({
    ok: true,
    workdir: target,
    name: path.basename(target),
    projects: projectsPayload(config.loadConfig()),
  });
});

app.post("/api/project/create", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const cfg = config.loadConfig();
  const target = projects.createProject(projects.projectRoot(cfg), String(req.body?.name || ""));
  config.updateConfig({ workdir: target });
  res.json({
    ok: true,
    workdir: target,
    name: path.basename(target),
    projects: projectsPayload(config.loadConfig()),
  });
});

app.get("/api/files", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const cfg = config.loadConfig();
  const project = String(req.query.project || "");
  const rel = String(req.query.path || "");
  const root = safeProject(cfg, project);
  const target = safeIn(root, rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    res.status(400).json({ error: "La carpeta no existe." });
    return;
  }
  const dirents = fs.readdirSync(target, { withFileTypes: true });
  dirents.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  const entries = [];
  for (const item of dirents) {
    if (item.name.startsWith(".") || (item.isDirectory() && agent.SKIP_DIRS.has(item.name))) {
      continue;
    }
    let size = 0;
    if (item.isFile()) {
      try {
        size = fs.statSync(path.join(target, item.name)).size;
      } catch {
        size = 0;
      }
    }
    entries.push({
      name: item.name,
      dir: item.isDirectory(),
      size,
      path: rel ? `${rel}/${item.name}` : item.name,
    });
    if (entries.length >= 400) break;
  }
  res.json({ path: rel, entries });
});

app.get("/api/file", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const cfg = config.loadConfig();
  const project = String(req.query.project || "");
  const rel = String(req.query.path || "");
  const root = safeProject(cfg, project);
  const [text, log] = agent.readFile(root, rel);
  res.json({ path: rel, text, log });
});

// Usage & Favorites & Settings
app.get("/api/usage", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const provider = String(req.query.provider || "");
  const uid = String(req.query.uid || "");
  const stats = usage.getUsage(provider, uid);
  res.json({ text: usage.describeUsage(stats), today: stats.today || {}, total: stats });
});

app.post("/api/favorites", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const cfg = config.loadConfig();
  let favorites = [...(cfg.favorite_models || [])];
  const key = `${String(req.body?.provider || "")}:${String(req.body?.uid || "")}`;
  const favorite = Boolean(req.body?.favorite);
  if (favorite) {
    if (!favorites.includes(key)) favorites.push(key);
  } else {
    favorites = favorites.filter((item) => item !== key);
  }
  config.updateConfig({ favorite_models: favorites });
  res.json({ ok: true, favorites });
});

app.get("/api/settings", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  res.json(settingsPayload(config.loadConfig()));
});

app.post("/api/settings", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const data = req.body || {};
  const changes: Partial<UserConfig> = {};
  if ("openrouter_api_key" in data) {
    const key = String(data.openrouter_api_key || "").trim();
    changes.openrouter_api_key = key === "__clear__" ? "" : key;
  }
  if ("auto_refresh" in data) {
    changes.auto_refresh = Boolean(data.auto_refresh);
  }
  if (data.clear_usage) {
    changes.usage = {};
  }
  if (Object.keys(changes).length) {
    config.updateConfig(changes);
  }
  res.json(settingsPayload(config.loadConfig()));
});

// Custom providers
app.post("/api/custom/add", async (req: AuthedRequest, res, next) => {
  if (!requireUser(req, res)) return;
  try {
    const data = req.body || {};
    const cfg = config.loadConfig();
    const presetId = String(data.preset || "custom");
    const preset = custom.presetById(presetId);
    const name = String(data.name || preset.name).trim() || preset.name;
    const base = String(data.base || preset.base).trim().replace(/\/+$/, "");
    const key = String(data.key || "").trim();
    const rawCats = Array.isArray(data.categories) ? data.categories : ["code"];
    const categories = rawCats.filter((c: unknown) => c === "code" || c === "media") as string[];
    if (!categories.length) categories.push("code");
    if (!/^https?:\/\//.test(base)) {
      res.status(400).json({ error: "La URL debe empezar por http:// o https://" });
      return;
    }
    const pid = custom.uniqueId(cfg, presetId);
    const record = {
      id: pid,
      name,
      base,
      key,
      glyph: preset.glyph || "◆",
      color: preset.color || "#9aa4b2",
      categories,
    };
    const records = [...custom.records(cfg), record];
    config.updateConfig({ custom_providers: records });
    let error = "";
    try {
      const models = await custom.fetchCustomModels(record);
      catalog.storeModels(pid, models);
    } catch (err) {
      error = (err as Error).message;
    }
    res.json({ ok: true, provider: { ...record, key: undefined, key_set: Boolean(key) }, error });
  } catch (err) {
    next(err);
  }
});

app.post("/api/custom/update", async (req: AuthedRequest, res, next) => {
  if (!requireUser(req, res)) return;
  try {
    const data = req.body || {};
    const pid = String(data.id || "");
    const cfg = config.loadConfig();
    const records = custom.records(cfg).map((r) => ({ ...r }));
    const record = records.find((item) => item.id === pid);
    if (!record) {
      res.status(400).json({ error: "Ese proveedor no existe." });
      return;
    }
    if (typeof data.name === "string" && data.name.trim()) record.name = data.name.trim();
    if (typeof data.base === "string" && data.base.trim()) {
      const base = data.base.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(base)) {
        res.status(400).json({ error: "La URL debe empezar por http:// o https://" });
        return;
      }
      record.base = base;
    }
    if (typeof data.key === "string" && data.key.trim() && data.key.trim() !== "__keep__") {
      record.key = data.key.trim();
    }
    if (Array.isArray(data.categories)) {
      const cats = data.categories.filter((c: unknown) => c === "code" || c === "media") as string[];
      record.categories = cats.length ? cats : ["code"];
    }
    config.updateConfig({ custom_providers: records });
    let error = "";
    try {
      const models = await custom.fetchCustomModels(record);
      catalog.storeModels(pid, models);
    } catch (err) {
      error = (err as Error).message;
    }
    res.json({
      ok: true,
      provider: { ...record, key: undefined, key_set: Boolean(record.key) },
      error,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/custom/delete", (req: AuthedRequest, res) => {
  if (!requireUser(req, res)) return;
  const pid = String(req.body?.id || "");
  const cfg = config.loadConfig();
  const prev = custom.records(cfg);
  const nextRecords = prev.filter((item) => item.id !== pid);
  if (nextRecords.length === prev.length) {
    res.status(400).json({ error: "Ese proveedor no existe." });
    return;
  }
  config.updateConfig({ custom_providers: nextRecords });
  catalog.storeModels(pid, []);
  res.json({ ok: true });
});

// Admin invite access codes (Option 2: passwordless per-person revocable access)
app.get("/api/admin/codes", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ codes: access.listCodes() });
});

app.post("/api/admin/codes", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const body = req.body || {};
  const created = access.createAccessCode({
    label: String(body.label || ""),
    role: body.role === "admin" ? "admin" : "user",
    maxUses: body.max_uses != null ? Number(body.max_uses) : 1,
    expiresDays: body.expires_days != null && body.expires_days !== "" ? Number(body.expires_days) : null,
    bootstrapPack: body.bootstrap_pack && typeof body.bootstrap_pack === "object" ? body.bootstrap_pack : null,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, code: created.code, record: created.record });
});

app.post("/api/admin/codes/revoke", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const record = access.revokeAccessCode(String(req.body?.id || ""));
  res.json({ ok: true, record });
});

app.post("/api/admin/codes/delete", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  access.deleteAccessCode(String(req.body?.id || ""));
  res.json({ ok: true });
});

// Admin user management
app.get("/api/admin/users", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ users: users.listUsers(true) });
});

app.post("/api/admin/users", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const displayName = String(req.body?.display_name || req.body?.name || "").trim();
  const preferredId = String(req.body?.username || "").trim();
  const user = users.createUser(
    displayName || preferredId,
    String(req.body?.password || ""),
    req.body?.role === "admin" ? "admin" : "user",
    preferredId || undefined
  );
  res.json({ ok: true, user });
});

app.post("/api/admin/users/password", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  users.setPassword(String(req.body?.id || ""), String(req.body?.password || ""));
  res.json({ ok: true });
});

app.post("/api/admin/users/delete", (req: AuthedRequest, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  users.deleteUser(String(req.body?.id || ""), admin.id);
  res.json({ ok: true });
});

app.post("/api/admin/users/data", (req: AuthedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const target = users.setDataDir(String(req.body?.id || ""), String(req.body?.data_dir || ""));
  res.json({ ok: true, data_dir: target });
});

// Admin GitHub -> local folder sync (robocopy on Windows / rsync on Linux & macOS)
app.get("/api/admin/github-sync", async (req: AuthedRequest, res, next) => {
  if (!requireAdmin(req, res)) return;
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await githubSync.getSyncStatus());
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/github-sync", async (req: AuthedRequest, res, next) => {
  if (!requireAdmin(req, res)) return;
  try {
    const run = await githubSync.runGithubSync("manual", true);
    const status = await githubSync.getSyncStatus();
    res.status(run.ok ? 200 : 500).json({
      ok: run.ok,
      run,
      status,
      error: run.ok ? undefined : run.error || run.summary,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/admin/github-sync/config", async (req: AuthedRequest, res, next) => {
  if (!requireAdmin(req, res)) return;
  try {
    const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined;
    const rawInterval = req.body?.interval_seconds;
    const interval =
      rawInterval !== undefined && rawInterval !== null && Number.isFinite(Number(rawInterval))
        ? Number(rawInterval)
        : undefined;
    githubSync.setAutoSyncConfig({ enabled, interval_seconds: interval });
    res.json({ ok: true, status: await githubSync.getSyncStatus() });
  } catch (err) {
    next(err);
  }
});

// Optional GitHub Push Webhook (HMAC-SHA256 verified)
app.post("/api/webhook/github", (req: AuthedRequest, res) => {
  const secret = String(process.env.AIHUB_GITHUB_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    res.status(503).json({ error: "Webhook de GitHub no configurado en el servidor." });
    return;
  }
  const signature = String(req.headers["x-hub-signature-256"] || "");
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), "utf-8");
  if (!githubSync.verifyGithubSignature(rawBody, signature, secret)) {
    res.status(401).json({ error: "Firma de webhook no válida." });
    return;
  }
  const event = String(req.headers["x-github-event"] || "").toLowerCase();
  if (event === "ping") {
    res.json({ ok: true, event: "ping" });
    return;
  }
  if (event && event !== "push") {
    res.json({ ok: true, ignored: true, event });
    return;
  }
  const expectedRef = `refs/heads/${githubSync.getBranch()}`;
  const incomingRef = String(req.body?.ref || "");
  if (incomingRef && incomingRef !== expectedRef) {
    res.json({ ok: true, ignored: true, reason: "other-branch" });
    return;
  }
  void githubSync.runGithubSync("webhook", true).catch((err) => {
    console.error("[github-sync webhook]", err);
  });
  res.status(202).json({ ok: true, queued: true });
});

// Chat (SSE streaming)
app.post("/api/chat", async (req: AuthedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const data = req.body || {};
  const providerId = String(data.provider || "");
  const uid = String(data.uid || "");
  const category = String(data.category || "code");
  const projectName = String(data.project || "");
  const useTools = Boolean(data.use_tools);
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];

  if (category !== "code") {
    res.status(400).json({ error: "Ese modelo no es de chat." });
    return;
  }

  const cfg = config.loadConfig();
  const stateless = Boolean(data.stateless);
  const clientAuth = parseClientAuth(data.client_auth);
  const providers = new Map(providerList(cfg).map((p) => [p.id, p]));
  const hasClientCustom = Boolean(clientAuth && clientAuth.base);
  if (!providers.has(providerId) && !hasClientCustom) {
    res.status(400).json({ error: "Proveedor desconocido." });
    return;
  }

  const messages: ChatMessage[] = [];
  for (const item of rawMessages.slice(-MAX_HISTORY)) {
    if (!item || typeof item !== "object") continue;
    const role = String(item.role || "");
    const content = item.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
      continue;
    }
    messages.push({ role, content: content.slice(0, 120_000) });
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    res.status(400).json({ error: "Falta el mensaje del usuario." });
    return;
  }

  let root: string | null = null;
  if (projectName) {
    try {
      const resolved = safeProject(cfg, projectName);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        root = resolved;
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
  }

  // Respect the model's real context window when available in the catalog or sent by the client
  const cachedModel = catalog.cachedModels(providerId).models.find((m) => m.uid === uid);
  const clientContext = Number(data.model_context);
  const limit =
    Number.isFinite(clientContext) && clientContext > 0
      ? clientContext
      : cachedModel?.context && cachedModel.context > 0
        ? cachedModel.context
        : providerId === "ollama"
          ? chat.OLLAMA_CONTEXT
          : chat.DEFAULT_CONTEXT;

  const systemPrompt = root && useTools ? agent.systemPrompt(root) : chat.DEFAULT_SYSTEM_PROMPT;
  const built = chat.buildMessages(messages, { limit, systemPrompt });

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  const sendEvent = (event: Record<string, unknown>) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const started = Date.now();
  sendEvent({ type: "start", model: uid, provider: providerId });
  const trimNote = chat.contextNote(built.info);
  if (trimNote) {
    sendEvent({ type: "system", message: trimNote });
  }
  const usageTotal: Record<string, number> = {};

  const runTool = (name: string, args: Record<string, unknown>, projectDir: string): string => {
    sendEvent({ type: "tool", status: "run", name, detail: agent.describeTool(name, args) });
    try {
      const [result, log] = agent.executeTool(name, args, projectDir);
      sendEvent({ type: "tool", status: "done", name, detail: log });
      return result;
    } catch (err) {
      sendEvent({ type: "tool", status: "error", name, detail: (err as Error).message });
      return `Error: ${(err as Error).message}`;
    }
  };

  try {
    const savedCustom = !stateless ? custom.getCustom(cfg, providerId) : null;
    const resolvedBase = String(clientAuth?.base || savedCustom?.base || "").trim();
    const isOllama =
      providerId === "ollama" ||
      providerId.toLowerCase().includes("ollama") ||
      resolvedBase.includes(":11434");
    const isOpenRouter =
      providerId === "openrouter" || resolvedBase.toLowerCase().includes("openrouter.ai");

    if (isOllama) {
      const ollamaBase = resolvedBase || undefined;
      if (root && useTools) {
        const msgs = [...built.messages];
        let finished = false;
        for (let round = 0; round < TOOL_ROUNDS; round++) {
          const response = await api.chatOllamaTools(uid, msgs, agent.TOOLS, ollamaBase);
          addUsageTotals(usageTotal, (response.usage || {}) as Record<string, unknown>);
          const choices = Array.isArray(response.choices) ? response.choices : [{}];
          const message = ((choices[0] as Record<string, unknown>)?.message || {}) as Record<
            string,
            unknown
          >;
          const calls = Array.isArray(message.tool_calls)
            ? (message.tool_calls as Array<Record<string, unknown>>)
            : [];
          if (!calls.length) {
            const text = String(message.content || "");
            if (text) sendEvent({ type: "delta", text });
            finished = true;
            break;
          }
          msgs.push({
            role: "assistant",
            content: String(message.content || ""),
            tool_calls: calls,
          });
          for (const call of calls) {
            const fn = (call.function || {}) as Record<string, unknown>;
            const name = String(fn.name || "");
            let args: Record<string, unknown> = {};
            try {
              args =
                typeof fn.arguments === "string"
                  ? JSON.parse(fn.arguments || "{}")
                  : ((fn.arguments || {}) as Record<string, unknown>);
            } catch {
              args = {};
            }
            const result = runTool(name, args, root);
            msgs.push({
              role: "tool",
              tool_call_id: String(call.id || `call_${name}`),
              name,
              content: result,
            });
          }
        }
        if (!finished) {
          sendEvent({
            type: "delta",
            text: "\n\n(Se alcanzó el límite de pasos con herramientas.)",
          });
        }
      } else {
        const stats = await api.streamOllamaChat(
          uid,
          built.messages,
          (text) => sendEvent({ type: "delta", text }),
          abortController.signal,
          ollamaBase
        );
        addUsageTotals(usageTotal, stats);
      }
    } else {
      let key = "";
      let base = api.BASE;
      if (isOpenRouter) {
        key = clientAuth?.apiKey || String(savedCustom?.key || "") || config.openrouterKey(cfg, false);
        base = resolvedBase || api.BASE;
      } else if (clientAuth && clientAuth.base) {
        key = clientAuth.apiKey;
        base = clientAuth.base;
      } else {
        key = String(savedCustom?.key || "");
        base = String(savedCustom?.base || "");
      }
      const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(base);
      if (!key && !isLocalBase) {
        throw new api.ApiError("Falta la clave de este proveedor. Añádela en Ajustes.");
      }
      if (root && useTools) {
        const msgs = [...built.messages];
        let finished = false;
        for (let round = 0; round < TOOL_ROUNDS; round++) {
          const response = await api.chatTools(key, uid, msgs, agent.TOOLS, base);
          addUsageTotals(usageTotal, (response.usage || {}) as Record<string, unknown>);
          const choices = Array.isArray(response.choices) ? response.choices : [{}];
          const message = ((choices[0] as Record<string, unknown>)?.message || {}) as Record<
            string,
            unknown
          >;
          const calls = Array.isArray(message.tool_calls)
            ? (message.tool_calls as Array<Record<string, unknown>>)
            : [];
          if (!calls.length) {
            const text = String(message.content || "");
            if (text) sendEvent({ type: "delta", text });
            finished = true;
            break;
          }
          msgs.push({
            role: "assistant",
            content: String(message.content || ""),
            tool_calls: calls,
          });
          for (const call of calls) {
            const fn = (call.function || {}) as Record<string, unknown>;
            const name = String(fn.name || "");
            let args: Record<string, unknown> = {};
            try {
              args =
                typeof fn.arguments === "string"
                  ? JSON.parse(fn.arguments || "{}")
                  : ((fn.arguments || {}) as Record<string, unknown>);
            } catch {
              args = {};
            }
            const result = runTool(name, args, root);
            msgs.push({
              role: "tool",
              tool_call_id: String(call.id || `call_${name}`),
              name,
              content: result,
            });
          }
        }
        if (!finished) {
          sendEvent({
            type: "delta",
            text: "\n\n(Se alcanzó el límite de pasos con herramientas.)",
          });
        }
      } else {
        const stats = await api.streamOpenRouterChat(
          key,
          uid,
          built.messages,
          (text) => sendEvent({ type: "delta", text }),
          base,
          abortController.signal
        );
        addUsageTotals(usageTotal, stats);
      }
    }

    let usageText = "";
    if (!stateless) {
      if (Object.keys(usageTotal).length) {
        usage.recordUsage(providerId, uid, {
          prompt: usageTotal.prompt_tokens || 0,
          completion: usageTotal.completion_tokens || 0,
          cost: usageTotal.cost || 0,
        });
      }
      const stats = usage.getUsage(providerId, uid);
      usageText = usage.describeUsage(stats);
    }
    sendEvent({
      type: "done",
      elapsed: Number(((Date.now() - started) / 1000).toFixed(1)),
      usage: usageTotal,
      usage_text: usageText,
      context: {
        turns: built.info.turns,
        tokens: built.info.tokens,
        limit: built.info.limit,
        dropped: built.info.dropped,
        truncated: built.info.truncated,
        note: trimNote,
      },
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      sendEvent({
        type: "error",
        message: err instanceof api.ApiError ? err.message : `Error inesperado: ${(err as Error).message}`,
      });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// Image & Video generation + Media serving
app.post("/api/image", async (req: AuthedRequest, res, next) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const cfg = config.loadConfig();
    const stateless = Boolean(req.body?.stateless);
    const clientAuth = parseClientAuth(req.body?.client_auth);
    const provider = String(req.body?.provider || "openrouter");
    const uid = String(req.body?.uid || "");
    const prompt = String(req.body?.prompt || "").trim();
    const aspect = String(req.body?.aspect_ratio || "").trim() || null;
    if (!prompt) {
      res.status(400).json({ error: "Escribe qué imagen quieres generar." });
      return;
    }
    const outDir = config.imageDir(cfg);
    let generated: { filePath: string; cost: number | null; media: string };
    const savedCustom = !stateless ? custom.getCustom(cfg, provider) : null;
    const imgBase = String(clientAuth?.base || savedCustom?.base || "").trim();
    const isOpenRouterImg =
      provider === "openrouter" || imgBase.toLowerCase().includes("openrouter.ai");
    if (isOpenRouterImg) {
      const key = clientAuth?.apiKey || String(savedCustom?.key || "") || config.openrouterKey(cfg, false);
      if (!key) throw new api.ApiError("Falta la clave de OpenRouter. Configúrala en Ajustes → Proveedores.");
      generated = await api.generateImage(key, uid, prompt, outDir, aspect);
    } else if (clientAuth && clientAuth.base && clientAuth.apiKey) {
      generated = await api.generateImageOpenAI(clientAuth.base, clientAuth.apiKey, uid, prompt, outDir);
    } else {
      if (!savedCustom?.key || !savedCustom?.base) {
        throw new api.ApiError("Falta la clave o la URL de ese proveedor.");
      }
      generated = await api.generateImageOpenAI(savedCustom.base, savedCustom.key, uid, prompt, outDir);
    }
    if (!stateless) {
      usage.recordUsage(provider, uid, { images: 1, cost: generated.cost || 0 });
    }
    const rel = mediaRelative(cfg, user.id, generated.filePath);
    res.json({
      ok: true,
      url: `/api/media?path=${encodeURIComponent(rel)}`,
      cost: generated.cost,
      name: path.basename(generated.filePath),
      usage: { images: 1, cost: generated.cost || 0 },
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/video", async (req: AuthedRequest, res, next) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const cfg = config.loadConfig();
    const stateless = Boolean(req.body?.stateless);
    const clientAuth = parseClientAuth(req.body?.client_auth);
    const uid = String(req.body?.uid || "");
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt) {
      res.status(400).json({ error: "Escribe qué vídeo quieres generar." });
      return;
    }
    const provider = String(req.body?.provider || "openrouter");
    const savedCustom = !stateless ? custom.getCustom(cfg, provider) : null;
    const key = clientAuth?.apiKey || String(savedCustom?.key || "") || config.openrouterKey(cfg, false);
    if (!key) throw new api.ApiError("Falta la clave de OpenRouter. Configúrala en Ajustes → Proveedores.");
    const rawDuration = req.body?.duration;
    const duration =
      rawDuration != null && rawDuration !== "" && Number.isFinite(Number(rawDuration))
        ? Math.floor(Number(rawDuration))
        : null;
    const filePath = await api.generateVideo(key, uid, prompt, config.videoDir(cfg), {
      duration,
      resolution: String(req.body?.resolution || "") || null,
      aspectRatio: String(req.body?.aspect_ratio || "") || null,
    });
    if (!stateless) {
      usage.recordUsage(provider, uid, { videos: 1 });
    }
    const rel = mediaRelative(cfg, user.id, filePath);
    res.json({
      ok: true,
      url: `/api/media?path=${encodeURIComponent(rel)}`,
      name: path.basename(filePath),
      usage: { videos: 1 },
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/media", (req: AuthedRequest, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const cfg = config.loadConfig();
  const rel = String(req.query.path || "");
  const bases = mediaBases(cfg, user.id);
  let target: string | null = null;
  if (path.isAbsolute(rel)) {
    const resolved = path.resolve(rel);
    if (bases.some((b) => isInside(b, resolved)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      target = resolved;
    }
  } else {
    for (const base of bases) {
      try {
        const candidate = safeIn(base, rel);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          target = candidate;
          break;
        }
      } catch {
        // continue
      }
    }
  }
  if (!target) {
    res.status(404).json({ error: "Archivo no encontrado." });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(target);
});

// Central error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof api.ApiError) {
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof agent.ToolError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof Error) {
    const status = /no existe|inválid|no válid|vacía|caracteres|debe |no puedes|carpeta/i.test(
      err.message
    )
      ? 400
      : 500;
    if (status === 500) console.error("[server]", err);
    res.status(status).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: "Error interno del servidor." });
});

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

fs.mkdirSync(users.webDir(), { recursive: true });
app.listen(PORT, HOST, () => {
  console.log(`AI Hub web ${APP_VERSION} · http://${HOST}:${PORT}`);
  if (!access.hasAnyAdmin()) {
    console.log("Primera vez: abre la URL y crea tu código maestro de administrador.");
  }
  githubSync.startAutoSyncScheduler();
});
