import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.ts";
import type { PublicUser, UserRecord } from "./types.ts";

const ITERATIONS = 260_000;
const COOKIE_NAME = "aihub_session";
const SESSION_DAYS = 30;

export function webDir(): string {
  const env = process.env.AIHUB_WEB_DIR;
  return env ? path.resolve(env) : path.join(config.APP_DIR, "web");
}

function usersFile(): string {
  return path.join(webDir(), "users.json");
}

function secretFile(): string {
  return path.join(webDir(), "secret.key");
}

function readUsers(): UserRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(usersFile(), "utf-8"));
    const items = Array.isArray(raw) ? raw : raw?.users;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is UserRecord => Boolean(item && typeof item === "object"));
  } catch {
    return [];
  }
}

function writeUsers(users: UserRecord[]): void {
  const base = webDir();
  fs.mkdirSync(base, { recursive: true });
  const target = usersFile();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

export function slugify(name: string): string {
  const text = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text.slice(0, 32) || "usuario";
}

function hashPassword(password: string, salt: Buffer, iterations = ITERATIONS): string {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
}

export function dataDir(user: UserRecord | null | undefined): string | null {
  const raw = String(user?.data_dir || "").trim();
  return raw ? path.resolve(raw) : null;
}

export function publicUser(user: UserRecord, detailed = false): PublicUser {
  const linked = dataDir(user);
  const out: PublicUser = {
    id: user.id,
    name: user.name,
    role: user.role === "admin" ? "admin" : "user",
    created: user.created,
    desktop: Boolean(linked),
  };
  if (detailed) {
    out.data_dir = linked || "";
  }
  return out;
}

export function listUsers(detailed = false): PublicUser[] {
  return readUsers().map((item) => publicUser(item, detailed));
}

export function getUser(userId: string): UserRecord | null {
  return readUsers().find((item) => item.id === userId) || null;
}

export function hasUsers(): boolean {
  return readUsers().length > 0;
}

export function userDir(userId: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(userId || ""))) {
    throw new Error("Identificador de usuario no válido.");
  }
  return path.join(webDir(), "users", userId);
}

export function effectiveDir(userId: string): string {
  const user = getUser(userId);
  const linked = dataDir(user);
  return linked || userDir(userId);
}

export function ensureUserEnv(userId: string): string {
  const user = getUser(userId);
  const linked = dataDir(user);
  let base: string;
  if (linked) {
    base = linked;
    fs.mkdirSync(base, { recursive: true });
  } else {
    base = userDir(userId);
    fs.mkdirSync(path.join(base, "proyectos"), { recursive: true });
    fs.mkdirSync(path.join(base, "salida"), { recursive: true });
  }
  const cfgFile = path.join(base, "config.json");
  if (!fs.existsSync(cfgFile)) {
    config.runWithAppDir(base, () => {
      config.saveConfig(config.defaultConfig(base));
    });
  }
  return base;
}

export function createUser(
  name: string,
  password: string,
  role: "admin" | "user" = "user",
  preferredId?: string
): PublicUser {
  const cleanName = String(name || "").split(/\s+/).join(" ").trim();
  if (cleanName.length < 2) {
    throw new Error("El nombre debe tener al menos 2 caracteres.");
  }
  if ((password || "").length < 6) {
    throw new Error("El código maestro o contraseña debe tener al menos 6 caracteres.");
  }
  const cleanRole: "admin" | "user" = role === "admin" ? "admin" : "user";
  const users = readUsers();
  const taken = new Set(users.map((u) => u.id));
  const base = slugify(preferredId && preferredId.trim() ? preferredId : cleanName);
  let userId = base;
  let num = 2;
  while (taken.has(userId)) {
    userId = `${base}-${num}`;
    num += 1;
  }
  const salt = crypto.randomBytes(16);
  const record: UserRecord = {
    id: userId,
    name: cleanName,
    role: cleanRole,
    salt: salt.toString("hex"),
    hash: hashPassword(password, salt),
    iterations: ITERATIONS,
    created: Math.floor(Date.now() / 1000),
  };
  users.push(record);
  writeUsers(users);
  ensureUserEnv(userId);
  return publicUser(record);
}

export function verifyUser(name: string, password: string): PublicUser | null {
  const wanted = String(name || "").trim().toLowerCase();
  for (const user of readUsers()) {
    if (user.id.toLowerCase() !== wanted && user.name.toLowerCase() !== wanted) {
      continue;
    }
    try {
      const salt = Buffer.from(String(user.salt || ""), "hex");
      const expected = Buffer.from(String(user.hash || ""), "hex");
      const actual = Buffer.from(
        hashPassword(password || "", salt, user.iterations || ITERATIONS),
        "hex"
      );
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        return publicUser(user);
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function verifyAdminMasterCode(rawCode: string): PublicUser | null {
  const candidate = String(rawCode || "");
  if (!candidate) return null;
  for (const user of readUsers()) {
    if (user.role !== "admin") continue;
    try {
      const salt = Buffer.from(String(user.salt || ""), "hex");
      const expected = Buffer.from(String(user.hash || ""), "hex");
      const actual = Buffer.from(
        hashPassword(candidate, salt, user.iterations || ITERATIONS),
        "hex"
      );
      if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
        return publicUser(user);
      }
    } catch {
      // continue
    }
  }
  return null;
}

export function setPassword(userId: string, password: string): void {
  if ((password || "").length < 6) {
    throw new Error("El código maestro o contraseña debe tener al menos 6 caracteres.");
  }
  const users = readUsers();
  const user = users.find((item) => item.id === userId);
  if (!user) throw new Error("Ese usuario no existe.");
  const salt = crypto.randomBytes(16);
  user.salt = salt.toString("hex");
  user.hash = hashPassword(password, salt);
  user.iterations = ITERATIONS;
  writeUsers(users);
}

export function deleteUser(userId: string, requesterId: string): void {
  const users = readUsers();
  const target = users.find((item) => item.id === userId);
  if (!target) throw new Error("Ese usuario no existe.");
  if (userId === requesterId) {
    throw new Error("No puedes borrar tu propia cuenta.");
  }
  const admins = users.filter((item) => item.role === "admin");
  if (target.role === "admin" && admins.length <= 1) {
    throw new Error("Debe quedar al menos un administrador.");
  }
  writeUsers(users.filter((item) => item.id !== userId));
}

export function setDataDir(userId: string, raw: string): string {
  const users = readUsers();
  const user = users.find((item) => item.id === userId);
  if (!user) throw new Error("Ese usuario no existe.");
  const value = String(raw || "").trim();
  if (value === "" || value === "__none__") {
    delete user.data_dir;
  } else if (value === "__desktop__") {
    fs.mkdirSync(config.APP_DIR, { recursive: true });
    user.data_dir = config.APP_DIR;
  } else {
    if (!path.isAbsolute(value)) {
      throw new Error("Escribe una ruta absoluta.");
    }
    const target = path.resolve(value);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
      throw new Error("Esa carpeta no existe.");
    }
    user.data_dir = target;
  }
  writeUsers(users);
  return dataDir(user) || "";
}

let cachedSecret: Buffer | null = null;

function getSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const p = secretFile();
  try {
    if (fs.existsSync(p)) {
      cachedSecret = fs.readFileSync(p);
      return cachedSecret;
    }
  } catch {
    // Regenerate if unreadable
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const token = crypto.randomBytes(48);
  fs.writeFileSync(p, token, { mode: 0o600 });
  cachedSecret = token;
  return token;
}

export function makeSession(subjectId: string, tokenVersion = 1): string {
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${subjectId}.v${tokenVersion}.${expires}`;
  const sig = crypto.createHmac("sha256", getSecret()).update(payload, "utf-8").digest("hex");
  return `${payload}.${sig}`;
}

export function readSessionEx(token: string | undefined): { subjectId: string; tokenVersion: number } | null {
  const parts = String(token || "").split(".");
  let subjectId = "";
  let tokenVersion = 1;
  let rawExp = "";
  let sig = "";
  let payload = "";
  if (parts.length === 4 && parts[1].startsWith("v")) {
    [subjectId, , rawExp, sig] = parts;
    tokenVersion = Number(parts[1].slice(1));
    if (!Number.isFinite(tokenVersion) || tokenVersion < 1) return null;
    payload = `${subjectId}.${parts[1]}.${rawExp}`;
  } else if (parts.length === 3) {
    [subjectId, rawExp, sig] = parts;
    payload = `${subjectId}.${rawExp}`;
  } else {
    return null;
  }
  const expected = crypto.createHmac("sha256", getSecret()).update(payload, "utf-8").digest("hex");
  try {
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
  return { subjectId, tokenVersion };
}

export function readSession(token: string | undefined): string | null {
  const parsed = readSessionEx(token);
  if (!parsed) return null;
  return getUser(parsed.subjectId) ? parsed.subjectId : null;
}

export function cookieHeader(subjectId: string, secure: boolean, tokenVersion = 1): string {
  const token = makeSession(subjectId, tokenVersion);
  const bits = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    secure ? "SameSite=None" : "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) {
    bits.push("Secure", "Partitioned");
  }
  return bits.join("; ");
}

export function clearCookieHeader(secure: boolean): string {
  const bits = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    secure ? "SameSite=None" : "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) {
    bits.push("Secure", "Partitioned");
  }
  return bits.join("; ");
}

export function cookieName(): string {
  return COOKIE_NAME;
}
