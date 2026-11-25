import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as config from "./config.ts";
import type { UserConfig } from "./types.ts";

export const GITHUB_API = "https://api.github.com";
export const DEFAULT_GITHUB_OWNER = "miguelmarin18630";
export const DEFAULT_GITHUB_BRANCH = "main";
export const DEFAULT_GIT_NAME = "AI Hub";
export const DEFAULT_GIT_EMAIL = "aihub@localhost";

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const API_TIMEOUT_MS = 20_000;
const CREDENTIAL_TTL_MS = 5 * 60_000;

export type GitHubTokenSource = "config" | "env" | "git";

export interface GitHubCredential {
  token: string;
  source: GitHubTokenSource;
}

export interface GitHubStatus {
  available: boolean;
  owner: string;
  login: string;
  source: GitHubTokenSource | "";
  message: string;
}

export interface CreatedRepo {
  owner: string;
  name: string;
  full_name: string;
  url: string;
  branch: string;
  folder: string;
  created: boolean;
  pushed: boolean;
  warning?: string;
}

export interface CreateRepoOptions {
  folder: string;
  name?: string;
  owner?: string;
  isPrivate?: boolean;
  description?: string;
  cfg?: UserConfig;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RepoInfo {
  name?: string;
  full_name?: string;
  html_url?: string;
  default_branch?: string;
  owner?: { login?: string };
}

interface ApiResponse<T> {
  status: number;
  data: T | null;
  message: string;
}

let credentialCache: { value: GitHubCredential; at: number } | null = null;

/** Convierte el nombre del proyecto en un nombre válido de repositorio de GitHub. */
export function sanitizeRepoName(raw: string): string {
  const clean = String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 100);
  return clean || "proyecto";
}

/** URL pública del repositorio (sin `.git`). */
export function repoWebUrl(owner: string, repo: string): string {
  const cleanOwner = String(owner || "").trim();
  const cleanRepo = String(repo || "")
    .trim()
    .replace(/\.git$/i, "");
  if (!cleanOwner || !cleanRepo) return "";
  return `https://github.com/${cleanOwner}/${cleanRepo}`;
}

/** Oculta tokens en textos de error antes de mostrarlos al usuario. */
export function redactSecrets(text: string): string {
  return String(text || "")
    .replace(/x-access-token:[^\s@/]+@/gi, "x-access-token:***@")
    .replace(/https:\/\/[^\s@/]+:[^\s@/]+@github\.com/gi, "https://***@github.com")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/g, "***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, "***");
}

export function describeGithubError(status: number, message: string): string {
  if (status === 401) {
    return "GitHub rechazó las credenciales. Revisa el token o vuelve a iniciar sesión con Git.";
  }
  if (status === 403) {
    return "GitHub denegó el permiso. El token necesita el permiso «repo».";
  }
  if (status === 404) {
    return "GitHub no encontró la cuenta o el repositorio indicado.";
  }
  if (status === 422) {
    return `GitHub no pudo crear el repositorio${message ? `: ${message}` : " (datos no válidos)"}.`;
  }
  if (status >= 500) {
    return "GitHub no está disponible ahora mismo. Inténtalo de nuevo en unos minutos.";
  }
  return `GitHub respondió con un error ${status}${message ? `: ${message}` : ""}.`;
}

export function githubOwner(cfg?: UserConfig): string {
  const current = cfg || config.loadConfig();
  return String(current.github_owner || "").trim() || DEFAULT_GITHUB_OWNER;
}

function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GIT_ASKPASS: "",
        },
      });
    } catch (err) {
      finish({ code: -1, stdout: "", stderr: (err as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ code: -1, stdout, stderr: `${stderr}\nTiempo de espera agotado.` });
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("error", (err: Error) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: err.message });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr });
    });
    if (child.stdin) {
      if (options.input) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

async function gitCredentialToken(): Promise<string> {
  const res = await run("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    timeoutMs: 10_000,
  });
  if (res.code !== 0) return "";
  let token = "";
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith("password=")) token = line.slice("password=".length).trim();
  }
  return token;
}

/**
 * Obtiene un token de GitHub, en este orden:
 * 1. `github_token` guardado en la configuración de AI Hub.
 * 2. Variables de entorno AIHUB_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN.
 * 3. Credenciales de Git ya guardadas en el equipo (Git Credential Manager).
 */
export async function resolveCredential(cfg?: UserConfig): Promise<GitHubCredential | null> {
  const current = cfg || config.loadConfig();
  const stored = String(current.github_token || "").trim();
  if (stored) return { token: stored, source: "config" };
  const envToken = String(
    process.env.AIHUB_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ""
  ).trim();
  if (envToken) return { token: envToken, source: "env" };
  if (credentialCache && Date.now() - credentialCache.at < CREDENTIAL_TTL_MS) {
    return credentialCache.value;
  }
  const token = await gitCredentialToken();
  if (!token) return null;
  const value: GitHubCredential = { token, source: "git" };
  credentialCache = { value, at: Date.now() };
  return value;
}

async function githubRequest<T>(
  method: string,
  endpoint: string,
  token: string,
  body?: unknown
): Promise<ApiResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}${endpoint}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AI-Hub",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    const message =
      data && typeof data === "object" && "message" in data
        ? String((data as Record<string, unknown>).message || "")
        : "";
    return { status: res.status, data: data as T | null, message };
  } finally {
    clearTimeout(timer);
  }
}

export async function githubStatus(cfg?: UserConfig): Promise<GitHubStatus> {
  const owner = githubOwner(cfg);
  const credential = await resolveCredential(cfg);
  if (!credential) {
    return {
      available: false,
      owner,
      login: "",
      source: "",
      message:
        "Sin credenciales de GitHub. Añade un token en la configuración o inicia sesión con Git en este equipo.",
    };
  }
  try {
    const res = await githubRequest<{ login?: string }>("GET", "/user", credential.token);
    if (res.status !== 200) {
      return {
        available: false,
        owner,
        login: "",
        source: credential.source,
        message: describeGithubError(res.status, res.message),
      };
    }
    const login = String(res.data?.login || "");
    return {
      available: true,
      owner: owner || login,
      login,
      source: credential.source,
      message: login ? `Conectado como ${login}` : "Conectado con GitHub",
    };
  } catch (err) {
    return {
      available: false,
      owner,
      login: "",
      source: credential.source,
      message: `No se pudo conectar con GitHub: ${(err as Error).message}`,
    };
  }
}

function ensureProjectFiles(folder: string, projectName: string, repoUrl: string): void {
  const readme = path.join(folder, "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `# ${projectName}\n\nProyecto creado con AI Hub.\n\nRepositorio: ${repoUrl}\n`,
      "utf-8"
    );
  }
  const gitignore = path.join(folder, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(
      gitignore,
      [".env", ".env.local", "node_modules/", "vault_backup.json", "*.log", ".DS_Store", ""].join(
        "\n"
      ),
      "utf-8"
    );
  }
}

/**
 * Crea el repositorio en GitHub, lo enlaza con la carpeta local,
 * hace el primer commit y sube el contenido a la rama principal.
 */
export async function createProjectRepo(options: CreateRepoOptions): Promise<CreatedRepo> {
  const cfg = options.cfg || config.loadConfig();
  const credential = await resolveCredential(cfg);
  if (!credential) {
    throw new Error(
      "No hay credenciales de GitHub. Añade un token en la configuración o inicia sesión con Git."
    );
  }
  const folder = path.resolve(options.folder);
  const projectName = String(options.name || path.basename(folder)).trim() || path.basename(folder);
  const repoName = sanitizeRepoName(projectName);

  const who = await githubRequest<{ login?: string }>("GET", "/user", credential.token);
  if (who.status !== 200) {
    throw new Error(describeGithubError(who.status, who.message));
  }
  const login = String(who.data?.login || "").trim();
  const owner = String(options.owner || githubOwner(cfg) || login).trim();
  if (!owner) {
    throw new Error("No se pudo determinar la cuenta de GitHub donde crear el repositorio.");
  }

  const isPrivate = options.isPrivate !== false;
  const description =
    String(options.description || "").trim() || `Proyecto ${projectName} creado con AI Hub.`;
  const endpoint =
    owner.toLowerCase() === login.toLowerCase()
      ? "/user/repos"
      : `/orgs/${encodeURIComponent(owner)}/repos`;

  let repo: RepoInfo | null = null;
  let created = false;
  const response = await githubRequest<RepoInfo>("POST", endpoint, credential.token, {
    name: repoName,
    private: isPrivate,
    description,
    auto_init: false,
    has_issues: true,
  });
  if (response.status === 201 && response.data) {
    repo = response.data;
    created = true;
  } else if (response.status === 422) {
    const existing = await githubRequest<RepoInfo>(
      "GET",
      `/repos/${owner}/${repoName}`,
      credential.token
    );
    if (existing.status === 200 && existing.data) {
      repo = existing.data;
      created = false;
    } else {
      throw new Error(describeGithubError(response.status, response.message));
    }
  } else {
    throw new Error(describeGithubError(response.status, response.message));
  }

  const finalName = String(repo.name || repoName);
  const url = String(repo.html_url || repoWebUrl(owner, finalName));
  ensureProjectFiles(folder, projectName, url);

  if (!fs.existsSync(path.join(folder, ".git"))) {
    const init = await run("git", ["init", "-b", DEFAULT_GITHUB_BRANCH], { cwd: folder });
    if (init.code !== 0) {
      throw new Error(`No se pudo iniciar Git en la carpeta: ${redactSecrets(init.stderr).trim()}`);
    }
  }

  await run("git", ["add", "-A"], { cwd: folder });
  const staged = await run("git", ["status", "--porcelain"], { cwd: folder });
  if (staged.stdout.trim()) {
    const commit = await run(
      "git",
      [
        "-c",
        `user.name=${DEFAULT_GIT_NAME}`,
        "-c",
        `user.email=${DEFAULT_GIT_EMAIL}`,
        "commit",
        "-m",
        `Proyecto ${projectName} creado con AI Hub`,
      ],
      { cwd: folder }
    );
    if (commit.code !== 0) {
      throw new Error(`No se pudo crear el primer commit: ${redactSecrets(commit.stderr).trim()}`);
    }
  }

  const remoteUrl = `https://github.com/${owner}/${finalName}.git`;
  await run("git", ["remote", "remove", "origin"], { cwd: folder });
  const remote = await run("git", ["remote", "add", "origin", remoteUrl], { cwd: folder });
  if (remote.code !== 0) {
    throw new Error(`No se pudo enlazar el repositorio: ${redactSecrets(remote.stderr).trim()}`);
  }

  const branch = String(repo.default_branch || DEFAULT_GITHUB_BRANCH);
  const authUrl = `https://x-access-token:${encodeURIComponent(credential.token)}@github.com/${owner}/${finalName}.git`;
  const push = await run("git", ["push", authUrl, `HEAD:refs/heads/${branch}`], {
    cwd: folder,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  let pushed = false;
  let warning = "";
  if (push.code === 0) {
    pushed = true;
    await run("git", ["branch", `--set-upstream-to=origin/${branch}`, branch], { cwd: folder });
  } else {
    const prefix = created
      ? "El repositorio se creó, pero no se pudo subir el contenido"
      : "El repositorio ya existía, pero no se pudo subir el contenido";
    warning = `${prefix}: ${redactSecrets(`${push.stderr}\n${push.stdout}`)
      .trim()
      .slice(0, 400)}`;
  }

  return {
    owner,
    name: finalName,
    full_name: `${owner}/${finalName}`,
    url,
    branch,
    folder,
    created,
    pushed,
    warning: warning || undefined,
  };
}
