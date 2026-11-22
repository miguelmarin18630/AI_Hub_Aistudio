import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CustomProviderRecord, PublicUser, UserRecord } from "./types.ts";
import * as users from "./users.ts";

export interface BootstrapPack {
  openrouter_api_key?: string;
  custom_providers?: CustomProviderRecord[];
}

export interface AccessCodeRecord {
  id: string; // 6-char lookup id (e.g. "ANA42K")
  label: string; // person's display name (e.g. "Ana")
  role: "admin" | "user";
  salt: string;
  hash: string; // scrypt(64) hex
  hint: string; // masked code preview (e.g. "AH-ANA42K-****")
  created: number;
  expires_at: number | null; // unix seconds or null
  max_uses: number; // 0 = unlimited, 1 = single-use (default)
  uses: number;
  revoked: boolean;
  token_version: number;
  last_used: number | null;
  bootstrap_pack?: BootstrapPack | null;
}

export interface PublicAccessCode {
  id: string;
  label: string;
  role: "admin" | "user";
  hint: string;
  created: number;
  expires_at: number | null;
  max_uses: number;
  uses: number;
  revoked: boolean;
  expired: boolean;
  exhausted: boolean;
  last_used: number | null;
  has_pack: boolean;
  pack_providers: number;
  pack_has_keys: boolean;
}

function codesFile(): string {
  return path.join(users.webDir(), "access_codes.json");
}

function readCodes(): AccessCodeRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(codesFile(), "utf-8"));
    const items = Array.isArray(raw) ? raw : raw?.codes;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is AccessCodeRecord => Boolean(item && typeof item === "object" && item.id));
  } catch {
    return [];
  }
}

function writeCodes(codes: AccessCodeRecord[]): void {
  const base = users.webDir();
  fs.mkdirSync(base, { recursive: true });
  const target = codesFile();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ codes }, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

function hashCode(rawCode: string, saltHex: string): string {
  return crypto.scryptSync(rawCode, Buffer.from(saltHex, "hex"), 32).toString("hex");
}

function verifyHash(rawCode: string, saltHex: string, expectedHex: string): boolean {
  try {
    const actual = Buffer.from(hashCode(rawCode, saltHex), "hex");
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function randomChars(len: number): string {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function normalizeCodeInput(raw: string): string {
  return String(raw || "").trim().toUpperCase().replace(/\s+/g, "");
}

function sanitizePack(raw: BootstrapPack | null | undefined): BootstrapPack | null {
  if (!raw || typeof raw !== "object") return null;
  const openrouterKey = typeof raw.openrouter_api_key === "string" ? raw.openrouter_api_key.trim() : "";
  const providers: CustomProviderRecord[] = [];
  if (Array.isArray(raw.custom_providers)) {
    for (const item of raw.custom_providers.slice(0, 30)) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "").trim();
      const name = String(item.name || "").trim();
      const base = String(item.base || "").trim().replace(/\/+$/, "");
      if (!id || !name || !/^https?:\/\//.test(base)) continue;
      const cats = Array.isArray(item.categories)
        ? item.categories.filter((c) => c === "code" || c === "media")
        : ["code"];
      providers.push({
        id,
        name,
        base,
        key: String(item.key || "").trim(),
        glyph: String(item.glyph || "◆"),
        color: String(item.color || "#9aa4b2"),
        categories: cats.length ? cats : ["code"],
      });
    }
  }
  if (!openrouterKey && !providers.length) return null;
  return {
    ...(openrouterKey ? { openrouter_api_key: openrouterKey } : {}),
    ...(providers.length ? { custom_providers: providers } : {}),
  };
}

export function publicCode(rec: AccessCodeRecord): PublicAccessCode {
  const now = Math.floor(Date.now() / 1000);
  const expired = Boolean(rec.expires_at && rec.expires_at < now);
  const exhausted = rec.max_uses > 0 && rec.uses >= rec.max_uses;
  const pack = rec.bootstrap_pack || null;
  const packProviders = Array.isArray(pack?.custom_providers) ? pack.custom_providers.length : 0;
  const packHasKeys = Boolean(
    pack?.openrouter_api_key ||
      (Array.isArray(pack?.custom_providers) && pack.custom_providers.some((p) => Boolean(p.key)))
  );
  return {
    id: rec.id,
    label: rec.label,
    role: rec.role === "admin" ? "admin" : "user",
    hint: rec.hint,
    created: rec.created,
    expires_at: rec.expires_at,
    max_uses: rec.max_uses,
    uses: rec.uses,
    revoked: rec.revoked,
    expired,
    exhausted,
    last_used: rec.last_used,
    has_pack: Boolean(pack),
    pack_providers: packProviders,
    pack_has_keys: packHasKeys,
  };
}

export function listCodes(): PublicAccessCode[] {
  return readCodes()
    .sort((a, b) => (b.created || 0) - (a.created || 0))
    .map(publicCode);
}

export function getCodeRecord(id: string): AccessCodeRecord | null {
  const wanted = String(id || "").trim().toUpperCase();
  return readCodes().find((item) => item.id.toUpperCase() === wanted) || null;
}

export function hasAnyAdmin(): boolean {
  if (process.env.AIHUB_ADMIN_CODE && process.env.AIHUB_ADMIN_CODE.trim().length >= 6) {
    return true;
  }
  if (users.hasUsers()) return true;
  return readCodes().some((c) => c.role === "admin" && !c.revoked);
}

export function createAccessCode(options: {
  label: string;
  role?: "admin" | "user";
  maxUses?: number;
  expiresDays?: number | null;
  bootstrapPack?: BootstrapPack | null;
}): { code: string; record: PublicAccessCode } {
  const cleanLabel = String(options.label || "").split(/\s+/).join(" ").trim();
  if (cleanLabel.length < 2) {
    throw new Error("Escribe un nombre o etiqueta de al menos 2 caracteres.");
  }
  const role: "admin" | "user" = options.role === "admin" ? "admin" : "user";
  const maxUses = Math.max(0, Math.min(100, Math.floor(Number(options.maxUses ?? 1))));
  const expiresDays =
    options.expiresDays != null && Number.isFinite(Number(options.expiresDays)) && Number(options.expiresDays) > 0
      ? Math.min(3650, Math.floor(Number(options.expiresDays)))
      : null;

  const existing = readCodes();
  const taken = new Set(existing.map((c) => c.id.toUpperCase()));
  const prefix = cleanLabel
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 3)
    .padEnd(3, "X");
  let id = `${prefix}${randomChars(3)}`;
  while (taken.has(id)) {
    id = `${prefix}${randomChars(3)}`;
  }

  const secretPart = `${randomChars(4)}-${randomChars(4)}`;
  const fullCode = `AH-${id}-${secretPart}`;
  const salt = crypto.randomBytes(16).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const record: AccessCodeRecord = {
    id,
    label: cleanLabel,
    role,
    salt,
    hash: hashCode(fullCode, salt),
    hint: `AH-${id}-••••-••••`,
    created: now,
    expires_at: expiresDays ? now + expiresDays * 86400 : null,
    max_uses: maxUses,
    uses: 0,
    revoked: false,
    token_version: 1,
    last_used: null,
    bootstrap_pack: sanitizePack(options.bootstrapPack),
  };

  existing.push(record);
  writeCodes(existing);
  return { code: fullCode, record: publicCode(record) };
}

export function revokeAccessCode(id: string): PublicAccessCode {
  const codes = readCodes();
  const target = codes.find((item) => item.id.toUpperCase() === String(id || "").trim().toUpperCase());
  if (!target) throw new Error("Ese código de acceso no existe.");
  target.revoked = true;
  target.token_version = (target.token_version || 1) + 1;
  // Wipe any pending bootstrap keys when revoked
  target.bootstrap_pack = null;
  writeCodes(codes);
  return publicCode(target);
}

export function deleteAccessCode(id: string): void {
  const codes = readCodes();
  const wanted = String(id || "").trim().toUpperCase();
  const next = codes.filter((item) => item.id.toUpperCase() !== wanted);
  if (next.length === codes.length) throw new Error("Ese código de acceso no existe.");
  writeCodes(next);
}

export function codeSubjectId(id: string): string {
  return `code:${id.toUpperCase()}`;
}

export function parseCodeSubject(subjectId: string): string | null {
  if (!subjectId.startsWith("code:")) return null;
  return subjectId.slice(5).trim().toUpperCase() || null;
}

export function isCodeSessionValid(subjectId: string, tokenVersion: number): UserRecord | null {
  if (subjectId === "env-admin") {
    const envCode = (process.env.AIHUB_ADMIN_CODE || "").trim();
    if (!envCode) return null;
    return {
      id: "admin",
      name: "Administrador",
      role: "admin",
      salt: "",
      hash: "",
      iterations: 0,
      created: 0,
    };
  }
  const codeId = parseCodeSubject(subjectId);
  if (!codeId) return null;
  const rec = getCodeRecord(codeId);
  if (!rec || rec.revoked) return null;
  const now = Math.floor(Date.now() / 1000);
  if (rec.expires_at && rec.expires_at < now) return null;
  if ((rec.token_version || 1) !== tokenVersion) return null;
  return {
    id: `code-${rec.id.toLowerCase()}`,
    name: rec.label,
    role: rec.role === "admin" ? "admin" : "user",
    salt: "",
    hash: "",
    iterations: 0,
    created: rec.created,
  };
}

export interface RedeemResult {
  subjectId: string;
  tokenVersion: number;
  user: PublicUser;
  bootstrapPack: BootstrapPack | null;
}

export function redeemCode(rawInput: string): RedeemResult | null {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) return null;

  // 1) Check server env AIHUB_ADMIN_CODE if configured
  const envAdmin = (process.env.AIHUB_ADMIN_CODE || "").trim();
  if (envAdmin.length >= 6) {
    const a = Buffer.from(trimmed, "utf-8");
    const b = Buffer.from(envAdmin, "utf-8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return {
        subjectId: "env-admin",
        tokenVersion: 1,
        user: {
          id: "admin",
          name: "Administrador",
          role: "admin",
          created: 0,
          desktop: false,
        },
        bootstrapPack: null,
      };
    }
  }

  // 2) Check structured invite codes: AH-<ID>-<PART1>-<PART2>
  const normalized = normalizeCodeInput(trimmed);
  const match = /^AH-([A-Z0-9]{4,10})-[A-Z0-9]{4}-[A-Z0-9]{4}$/.exec(normalized);
  if (match) {
    const codeId = match[1];
    const codes = readCodes();
    const rec = codes.find((item) => item.id.toUpperCase() === codeId);
    if (!rec) return null;
    if (!verifyHash(normalized, rec.salt, rec.hash)) return null;
    if (rec.revoked) {
      throw new Error("Este código de acceso ha sido revocado por el administrador.");
    }
    const now = Math.floor(Date.now() / 1000);
    if (rec.expires_at && rec.expires_at < now) {
      throw new Error("Este código de acceso ha caducado. Pide uno nuevo al administrador.");
    }
    if (rec.max_uses > 0 && rec.uses >= rec.max_uses) {
      throw new Error("Este código ya ha alcanzado su límite de usos. Pide uno nuevo al administrador.");
    }
    const pack = rec.bootstrap_pack ? { ...rec.bootstrap_pack } : null;
    rec.uses = (rec.uses || 0) + 1;
    rec.last_used = now;
    // Wipe one-time bootstrap keys from server once the code reaches max_uses
    if (rec.max_uses > 0 && rec.uses >= rec.max_uses) {
      rec.bootstrap_pack = null;
    }
    writeCodes(codes);
    return {
      subjectId: codeSubjectId(rec.id),
      tokenVersion: rec.token_version || 1,
      user: {
        id: `code-${rec.id.toLowerCase()}`,
        name: rec.label,
        role: rec.role === "admin" ? "admin" : "user",
        created: rec.created,
        desktop: false,
      },
      bootstrapPack: pack,
    };
  }

  // 3) Check existing admin account password directly as an admin master code (convenience for admin)
  const adminMatch = users.verifyAdminMasterCode(trimmed);
  if (adminMatch) {
    return {
      subjectId: adminMatch.id,
      tokenVersion: 1,
      user: adminMatch,
      bootstrapPack: null,
    };
  }

  return null;
}
