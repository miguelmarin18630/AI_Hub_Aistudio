import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.ts";

export const DEFAULT_GITHUB_REPO = "https://github.com/miguelmarin18630/AI_Hub_Aistudio.git";
export const DEFAULT_GITHUB_BRANCH = "main";
export const DEFAULT_WINDOWS_TARGET = "C:\\Proyectos\\AI_Hub_Aistudio";

export const EXCLUDED_DIRS: readonly string[] = [
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".cache",
];

export const EXCLUDED_FILES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.production",
  "vault.json",
  "vault_backup.json",
  "config.json",
  "cache.json",
  "conversations.json",
  "users.json",
  "access_codes.json",
  "secret.key",
  "*.lnk",
  "*.tmp",
];

export type SyncTrigger = "manual" | "auto" | "webhook";
export type CopyUtility = "robocopy" | "rsync" | "node-copy";

export interface SyncRunRecord {
  id: string;
  trigger: SyncTrigger;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  ok: boolean;
  changed: boolean;
  commit: string;
  commit_message: string;
  utility: CopyUtility;
  exit_code: number | null;
  summary: string;
  error?: string;
}

export interface SyncStatusPayload {
  repo: string;
  branch: string;
  target_dir: string;
  platform: NodeJS.Platform;
  utility: CopyUtility;
  supported_on_host: boolean;
  webhook_configured: boolean;
  auto_sync_enabled: boolean;
  interval_seconds: number;
  running: boolean;
  last_commit: string;
  last_run: SyncRunRecord | null;
  history: SyncRunRecord[];
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  enoent?: boolean;
}

interface PersistedSyncConfig {
  auto_sync_enabled?: boolean;
  interval_seconds?: number;
}

const MAX_HISTORY = 8;
const SAFE_BRANCH_RE = /^[a-zA-Z0-9._/-]{1,100}$/;

let running = false;
let lastSyncedCommit = "";
let lastSyncedFullSha = "";
let lastRun: SyncRunRecord | null = null;
const history: SyncRunRecord[] = [];
let autoTimer: ReturnType<typeof setInterval> | null = null;
let cachedUtility: CopyUtility | null = null;

function stateFilePath(): string {
  return path.join(config.APP_DIR, "github_sync_config.json");
}

function loadPersistedConfig(): PersistedSyncConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFilePath(), "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as PersistedSyncConfig;
    }
  } catch {
    // ignore missing config
  }
  return {};
}

function savePersistedConfig(data: PersistedSyncConfig): void {
  const file = stateFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function getRepoUrl(): string {
  const raw = String(process.env.AIHUB_GITHUB_REPO || "").trim();
  if (!raw) return DEFAULT_GITHUB_REPO;
  if (/^https:\/\/[^\s]+$/i.test(raw) && !raw.startsWith("-")) {
    return raw;
  }
  return DEFAULT_GITHUB_REPO;
}

export function getBranch(): string {
  const raw = String(process.env.AIHUB_GITHUB_BRANCH || "").trim();
  if (raw && SAFE_BRANCH_RE.test(raw) && !raw.startsWith("-") && !raw.includes("..")) {
    return raw;
  }
  return DEFAULT_GITHUB_BRANCH;
}

export function getTargetDir(): string {
  const raw = String(process.env.AIHUB_SYNC_TARGET_DIR || "").trim();
  if (raw) {
    return process.platform === "win32" ? path.win32.normalize(raw) : path.resolve(raw);
  }
  return DEFAULT_WINDOWS_TARGET;
}

export function isSupportedOnHost(): boolean {
  if (process.platform === "win32") return true;
  return Boolean(String(process.env.AIHUB_SYNC_TARGET_DIR || "").trim());
}

export function getIntervalSeconds(): number {
  const persisted = loadPersistedConfig();
  if (typeof persisted.interval_seconds === "number" && Number.isFinite(persisted.interval_seconds)) {
    return Math.max(15, Math.min(3600, Math.floor(persisted.interval_seconds)));
  }
  const envVal = Number(process.env.AIHUB_AUTO_SYNC_SECONDS);
  if (Number.isFinite(envVal) && envVal >= 15) {
    return Math.min(3600, Math.floor(envVal));
  }
  return 60;
}

export function isAutoSyncEnabled(): boolean {
  if (!isSupportedOnHost()) return false;
  const persisted = loadPersistedConfig();
  if (typeof persisted.auto_sync_enabled === "boolean") {
    return persisted.auto_sync_enabled;
  }
  const envFlag = String(process.env.AIHUB_AUTO_SYNC || "").trim().toLowerCase();
  if (envFlag === "0" || envFlag === "false" || envFlag === "off") return false;
  if (envFlag === "1" || envFlag === "true" || envFlag === "on") return true;
  return false;
}

export function isRobocopySuccess(exitCode: number): boolean {
  return Number.isInteger(exitCode) && exitCode >= 0 && exitCode < 8;
}

export function describeRobocopyExitCode(exitCode: number): string {
  if (exitCode === 0) return "Sin cambios nuevos en los archivos";
  if (exitCode === 1) return "Archivos actualizados correctamente";
  if (exitCode === 2) return "Archivos obsoletos limpiados";
  if (exitCode === 3) return "Archivos actualizados y limpiados";
  if (exitCode >= 4 && exitCode < 8) return `Sincronización completada (robocopy código ${exitCode})`;
  return `Error de robocopy (código ${exitCode})`;
}

export function buildRobocopyArgs(srcDir: string, dstDir: string): string[] {
  return [
    srcDir,
    dstDir,
    "/MIR",
    "/FFT",
    "/R:2",
    "/W:1",
    "/NFL",
    "/NDL",
    "/NJH",
    "/NJS",
    "/NP",
    "/XD",
    ...EXCLUDED_DIRS,
    "/XF",
    ...EXCLUDED_FILES,
  ];
}

export function buildRsyncArgs(srcDir: string, dstDir: string): string[] {
  const src = srcDir.endsWith("/") ? srcDir : `${srcDir}/`;
  const dst = dstDir.endsWith("/") ? dstDir : `${dstDir}/`;
  const args = ["-a", "--delete"];
  for (const dir of EXCLUDED_DIRS) {
    args.push("--exclude", `${dir}/`);
  }
  for (const file of EXCLUDED_FILES) {
    args.push("--exclude", file);
  }
  args.push(src, dst);
  return args;
}

export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string
): boolean {
  if (!secret || !signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const providedHex = signatureHeader.slice("sha256=".length).trim();
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) {
    return false;
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const provided = Buffer.from(providedHex, "hex");
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function runProcess(command: string, args: string[], timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        if (e.code === "ENOENT") {
          resolve({ code: -1, stdout: String(stdout || ""), stderr: String(stderr || ""), enoent: true });
          return;
        }
        const numericCode = typeof e.code === "number" ? e.code : 1;
        resolve({
          code: numericCode,
          stdout: String(stdout || ""),
          stderr: String(stderr || e.message || ""),
        });
      }
    );
  });
}

async function detectUtility(): Promise<CopyUtility> {
  if (cachedUtility) return cachedUtility;
  if (process.platform === "win32") {
    const check = await runProcess("robocopy", ["/?"], 5_000);
    cachedUtility = check.enoent ? "node-copy" : "robocopy";
    return cachedUtility;
  }
  const check = await runProcess("rsync", ["--version"], 5_000);
  cachedUtility = check.enoent ? "node-copy" : "rsync";
  return cachedUtility;
}

function matchesExcludedFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  for (const pattern of EXCLUDED_FILES) {
    const pLower = pattern.toLowerCase();
    if (pLower.startsWith("*.")) {
      if (lower.endsWith(pLower.slice(1))) return true;
    } else if (lower === pLower) {
      return true;
    }
  }
  return false;
}

function copyDirFiltered(srcDir: string, dstDir: string): number {
  fs.mkdirSync(dstDir, { recursive: true });
  let copied = 0;
  const excludedDirSet = new Set(EXCLUDED_DIRS.map((d) => d.toLowerCase()));
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirSet.has(entry.name.toLowerCase())) continue;
      copied += copyDirFiltered(srcPath, dstPath);
    } else if (entry.isFile()) {
      if (matchesExcludedFile(entry.name)) continue;
      fs.copyFileSync(srcPath, dstPath);
      copied += 1;
    }
  }
  return copied;
}

function stagingDir(): string {
  return path.join(config.APP_DIR, "github-sync-staging");
}

async function syncGitStaging(repoUrl: string, branch: string): Promise<{
  dir: string;
  fullSha: string;
  commit: string;
  message: string;
  changed: boolean;
}> {
  const dir = stagingDir();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const gitMarker = path.join(dir, ".git");

  let previousHead = "";
  if (!fs.existsSync(gitMarker)) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const clone = await runProcess("git", [
      "clone",
      "--branch",
      branch,
      "--single-branch",
      "--depth",
      "1",
      "--",
      repoUrl,
      dir,
    ]);
    if (clone.enoent) {
      throw new Error("Git no está instalado o no está en el PATH del servidor.");
    }
    if (clone.code !== 0) {
      throw new Error(`No se pudo clonar el repositorio de GitHub: ${(clone.stderr || clone.stdout).trim()}`);
    }
  } else {
    const prev = await runProcess("git", ["-C", dir, "rev-parse", "HEAD"]);
    previousHead = prev.code === 0 ? prev.stdout.trim() : "";

    const setUrl = await runProcess("git", ["-C", dir, "remote", "set-url", "origin", repoUrl]);
    if (setUrl.enoent) {
      throw new Error("Git no está instalado o no está en el PATH del servidor.");
    }

    const fetched = await runProcess("git", ["-C", dir, "fetch", "--depth", "1", "origin", branch]);
    if (fetched.code !== 0) {
      throw new Error(`No se pudieron obtener cambios de GitHub: ${(fetched.stderr || fetched.stdout).trim()}`);
    }

    const reset = await runProcess("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
    if (reset.code !== 0) {
      throw new Error(`No se pudo actualizar la copia local temporal: ${(reset.stderr || reset.stdout).trim()}`);
    }
    await runProcess("git", ["-C", dir, "clean", "-fd"]);
  }

  const headRes = await runProcess("git", ["-C", dir, "rev-parse", "HEAD"]);
  const fullHead = headRes.stdout.trim();
  const logRes = await runProcess("git", ["-C", dir, "log", "-1", "--format=%h%x1f%s"]);
  const [shortCommit = fullHead.slice(0, 7), subject = ""] = logRes.stdout.trim().split("\x1f");
  const changed = !previousHead || previousHead !== fullHead || lastSyncedFullSha !== fullHead;

  return {
    dir,
    fullSha: fullHead,
    commit: shortCommit,
    message: subject.trim(),
    changed,
  };
}

async function copyStagingToTarget(
  srcDir: string,
  dstDir: string
): Promise<{ utility: CopyUtility; exitCode: number; summary: string }> {
  fs.mkdirSync(dstDir, { recursive: true });
  const preferred = await detectUtility();

  if (preferred === "robocopy") {
    const res = await runProcess("robocopy", buildRobocopyArgs(srcDir, dstDir));
    if (!res.enoent) {
      if (!isRobocopySuccess(res.code)) {
        const detail = (res.stderr || res.stdout).trim().slice(0, 300);
        throw new Error(`${describeRobocopyExitCode(res.code)}${detail ? `: ${detail}` : ""}`);
      }
      return {
        utility: "robocopy",
        exitCode: res.code,
        summary: describeRobocopyExitCode(res.code),
      };
    }
  }

  if (preferred === "rsync") {
    const res = await runProcess("rsync", buildRsyncArgs(srcDir, dstDir));
    if (!res.enoent) {
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout).trim().slice(0, 300);
        throw new Error(`Error de rsync (código ${res.code})${detail ? `: ${detail}` : ""}`);
      }
      return {
        utility: "rsync",
        exitCode: 0,
        summary: "Carpeta sincronizada con rsync",
      };
    }
  }

  const count = copyDirFiltered(srcDir, dstDir);
  return {
    utility: "node-copy",
    exitCode: 0,
    summary: `Carpeta sincronizada (${count} archivos copiados)`,
  };
}

function recordRun(entry: SyncRunRecord): void {
  lastRun = entry;
  history.unshift(entry);
  if (history.length > MAX_HISTORY) {
    history.length = MAX_HISTORY;
  }
}

export async function runGithubSync(
  trigger: SyncTrigger = "manual",
  forceCopy = trigger !== "auto"
): Promise<SyncRunRecord> {
  if (running) {
    throw new Error("Ya hay una sincronización de GitHub en curso. Espera unos segundos.");
  }

  const startedAt = Date.now();
  const repoUrl = getRepoUrl();
  const branch = getBranch();
  const targetDir = getTargetDir();
  const utility = await detectUtility();

  if (!isSupportedOnHost()) {
    const record: SyncRunRecord = {
      id: crypto.randomUUID(),
      trigger,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      ok: false,
      changed: false,
      commit: "",
      commit_message: "",
      utility,
      exit_code: null,
      summary: "Destino Windows pendiente",
      error: `La ruta de destino (${targetDir}) es de Windows. Esta sincronización se ejecutará automáticamente con robocopy en tu servidor Windows (o define AIHUB_SYNC_TARGET_DIR en Linux/macOS).`,
    };
    recordRun(record);
    return record;
  }

  running = true;
  try {
    const staged = await syncGitStaging(repoUrl, branch);
    if (!forceCopy && !staged.changed && fs.existsSync(targetDir)) {
      const record: SyncRunRecord = {
        id: crypto.randomUUID(),
        trigger,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        ok: true,
        changed: false,
        commit: staged.commit,
        commit_message: staged.message,
        utility,
        exit_code: 0,
        summary: "Repositorio al día (sin cambios nuevos en GitHub)",
      };
      recordRun(record);
      return record;
    }

    const copied = await copyStagingToTarget(staged.dir, targetDir);
    lastSyncedFullSha = staged.fullSha;
    lastSyncedCommit = staged.commit;
    const record: SyncRunRecord = {
      id: crypto.randomUUID(),
      trigger,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      ok: true,
      changed: staged.changed || copied.exitCode !== 0,
      commit: staged.commit,
      commit_message: staged.message,
      utility: copied.utility,
      exit_code: copied.exitCode,
      summary: `${copied.summary} → ${targetDir}`,
    };
    recordRun(record);
    return record;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const record: SyncRunRecord = {
      id: crypto.randomUUID(),
      trigger,
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      ok: false,
      changed: false,
      commit: lastSyncedCommit,
      commit_message: "",
      utility,
      exit_code: null,
      summary: "Error durante la sincronización",
      error: msg,
    };
    recordRun(record);
    return record;
  } finally {
    running = false;
  }
}

export async function getSyncStatus(): Promise<SyncStatusPayload> {
  const utility = await detectUtility();
  return {
    repo: getRepoUrl(),
    branch: getBranch(),
    target_dir: getTargetDir(),
    platform: process.platform,
    utility,
    supported_on_host: isSupportedOnHost(),
    webhook_configured: Boolean(String(process.env.AIHUB_GITHUB_WEBHOOK_SECRET || "").trim()),
    auto_sync_enabled: isAutoSyncEnabled(),
    interval_seconds: getIntervalSeconds(),
    running,
    last_commit: lastSyncedCommit,
    last_run: lastRun,
    history: [...history],
  };
}

export function setAutoSyncConfig(options: {
  enabled?: boolean;
  interval_seconds?: number;
}): void {
  const current = loadPersistedConfig();
  if (typeof options.enabled === "boolean") {
    current.auto_sync_enabled = options.enabled;
  }
  if (typeof options.interval_seconds === "number" && Number.isFinite(options.interval_seconds)) {
    current.interval_seconds = Math.max(15, Math.min(3600, Math.floor(options.interval_seconds)));
  }
  savePersistedConfig(current);
  restartAutoSyncScheduler();
}

export function stopAutoSyncScheduler(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

export function restartAutoSyncScheduler(): void {
  stopAutoSyncScheduler();
  if (!isAutoSyncEnabled()) return;
  const intervalMs = getIntervalSeconds() * 1000;
  autoTimer = setInterval(() => {
    if (running) return;
    runGithubSync("auto", false)
      .then((res) => {
        if (!res.ok) {
          console.error(`[github-sync] ${res.error || res.summary}`);
        } else if (res.changed) {
          console.log(`[github-sync] ${res.commit} · ${res.summary}`);
        }
      })
      .catch((err) => {
        console.error("[github-sync]", err);
      });
  }, intervalMs);
  autoTimer.unref?.();
}

export function startAutoSyncScheduler(): void {
  if (!isAutoSyncEnabled()) return;
  console.log(
    `[github-sync] Sincronización automática activa cada ${getIntervalSeconds()}s → ${getTargetDir()}`
  );
  restartAutoSyncScheduler();
}
