import fs from "node:fs";
import path from "node:path";
import * as config from "./config.ts";
import type { UserConfig } from "./types.ts";

const MARKERS: Array<[string, string]> = [
  [".git", "git"],
  ["package.json", "web"],
  ["index.html", "web"],
  ["build.gradle", "Android"],
  ["build.gradle.kts", "Android"],
  ["AndroidManifest.xml", "Android"],
  ["pubspec.yaml", "Flutter"],
  ["pyproject.toml", "Python"],
  ["requirements.txt", "Python"],
];

export interface RawProject {
  name: string;
  path: string;
  root: boolean;
  kinds: string[];
  count: number;
  mtime: number;
  outside?: boolean;
}

export function projectRoot(cfg?: UserConfig): string {
  const current = cfg || config.loadConfig();
  const raw = String(current.projects_root || "").trim();
  const target = raw ? path.resolve(raw) : config.defaultProjectsRoot();
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function describeProject(dirPath: string, isRoot = false): RawProject {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    entries = [];
  }
  const kinds: string[] = [];
  for (const [marker, label] of MARKERS) {
    if (kinds.includes(label)) continue;
    try {
      if (fs.existsSync(path.join(dirPath, marker))) {
        kinds.push(label);
      }
    } catch {
      // ignore
    }
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(dirPath).mtimeMs / 1000;
  } catch {
    mtime = 0;
  }
  const visible = entries.filter((name) => !name.startsWith("."));
  return {
    name: path.basename(dirPath) || dirPath,
    path: path.resolve(dirPath),
    root: isRoot,
    kinds,
    count: visible.length,
    mtime,
  };
}

export function listProjects(cfg?: UserConfig): RawProject[] {
  const base = projectRoot(cfg);
  const out: RawProject[] = [];
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    out.push(describeProject(base, true));
    let children: fs.Dirent[] = [];
    try {
      children = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      children = [];
    }
    children.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    for (const child of children) {
      if (!child.isDirectory() || child.name.startsWith(".")) continue;
      out.push(describeProject(path.join(base, child.name), false));
    }
  }
  return out;
}

export function createProject(base: string, name: string): string {
  const clean = String(name || "")
    .split(/\s+/)
    .join(" ")
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, "");
  if (!clean) {
    throw new Error("Escribe un nombre para el proyecto.");
  }
  if (/[<>:"|?*]/.test(clean) || clean.includes("..")) {
    throw new Error('El nombre no puede llevar < > : " | ? *');
  }
  const resolvedBase = path.resolve(base);
  const target = path.resolve(resolvedBase, clean);
  const rel = path.relative(resolvedBase, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Nombre de proyecto no válido.");
  }
  fs.mkdirSync(target, { recursive: true });
  return target;
}
