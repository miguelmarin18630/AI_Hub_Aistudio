import fs from "node:fs";
import path from "node:path";

export const MAX_READ_CHARS = 20_000;
export const MAX_WRITE_CHARS = 200_000;
export const MAX_LIST_ENTRIES = 300;

export const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".next",
  ".nuxt",
  "build",
  "dist",
  ".gradle",
  ".idea",
  ".vscode",
]);

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "Lista archivos y carpetas dentro del proyecto.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Subcarpeta relativa al proyecto. Vacío o '.' para la raíz.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Lee un archivo de texto del proyecto.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del archivo." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Crea o reemplaza un archivo con el contenido indicado. Úsalo para archivos nuevos o reescrituras completas.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del archivo." },
          content: { type: "string", description: "Contenido completo del archivo." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description:
        "Reemplaza un fragmento de texto exacto dentro de un archivo existente. Mejor para cambios pequeños.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta relativa del archivo." },
          old: { type: "string", description: "Texto exacto que ya existe." },
          new: { type: "string", description: "Texto nuevo que lo sustituye." },
        },
        required: ["path", "old", "new"],
      },
    },
  },
];

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

function insideGit(filePath: string): boolean {
  return filePath.split(path.sep).some((part) => part.toLowerCase() === ".git");
}

function isRelativeInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveInRoot(root: string, raw?: string): string {
  const base = path.resolve(root);
  const text = String(raw || "").trim().replace(/^"+|"+$/g, "");
  if (!text || text === "." || text === "./") return base;
  const target = path.resolve(base, text);
  if (!isRelativeInside(base, target)) {
    throw new ToolError(`Ruta fuera del proyecto: ${text}`);
  }
  return target;
}

function toRelativePosix(root: string, filePath: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(filePath));
  return rel.split(path.sep).join("/") || ".";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function listFiles(root: string, relPath = ""): [string, string] {
  const folder = resolveInRoot(root, relPath);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new ToolError(`No es una carpeta: ${toRelativePosix(root, folder)}`);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (err) {
    throw new ToolError(`No se pudo leer la carpeta: ${(err as Error).message}`);
  }
  entries.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  const lines: string[] = [];
  let count = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    count += 1;
    if (count > MAX_LIST_ENTRIES) {
      lines.push(`… (más de ${MAX_LIST_ENTRIES} entradas, usa una subcarpeta)`);
      break;
    }
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
    } else {
      let size = 0;
      try {
        size = fs.statSync(path.join(folder, entry.name)).size;
      } catch {
        size = 0;
      }
      lines.push(`${entry.name} (${formatSize(size)})`);
    }
  }
  const rel = toRelativePosix(root, folder);
  const header = rel !== "." ? `${rel}/` : "./";
  const body = lines.length ? lines.join("\n") : "(carpeta vacía)";
  return [`${header}\n${body}`, `listar · ${rel} (${count} entradas)`];
}

export function readFile(root: string, relPath: string): [string, string] {
  const file = resolveInRoot(root, relPath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new ToolError(`No existe el archivo: ${toRelativePosix(root, file)}`);
  }
  let size = 0;
  let raw: Buffer;
  try {
    size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, MAX_READ_CHARS * 4 + 1));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      raw = buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new ToolError(`No se pudo leer: ${(err as Error).message}`);
  }
  if (raw.subarray(0, 4000).includes(0)) {
    throw new ToolError("El archivo parece binario y no se puede leer como texto.");
  }
  let text = raw.toString("utf-8");
  const truncated = text.length > MAX_READ_CHARS || size > raw.length;
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS);
  }
  const rel = toRelativePosix(root, file);
  const note = truncated ? `\n\n[truncado a ${MAX_READ_CHARS} caracteres]` : "";
  return [`Archivo ${rel}:\n${text}${note}`, `leer · ${rel} (${formatSize(size)})`];
}

export function writeFile(root: string, relPath: string, content: string): [string, string] {
  const file = resolveInRoot(root, relPath);
  if (insideGit(file)) throw new ToolError("No se escribe dentro de .git");
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    throw new ToolError(`Es una carpeta: ${toRelativePosix(root, file)}`);
  }
  if (content.length > MAX_WRITE_CHARS) {
    throw new ToolError("El contenido es demasiado grande (máximo 200 000 caracteres).");
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
  } catch (err) {
    throw new ToolError(`No se pudo escribir: ${(err as Error).message}`);
  }
  const rel = toRelativePosix(root, file);
  const lines = content.split("\n").length;
  return [
    `Escrito ${rel} (${content.length} caracteres, ${lines} líneas).`,
    `escribir · ${rel} (${formatSize(Buffer.byteLength(content, "utf-8"))})`,
  ];
}

export function replaceInFile(
  root: string,
  relPath: string,
  oldText: string,
  newText: string
): [string, string] {
  const file = resolveInRoot(root, relPath);
  if (insideGit(file)) throw new ToolError("No se escribe dentro de .git");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new ToolError(`No existe el archivo: ${toRelativePosix(root, file)}`);
  }
  if (!oldText) throw new ToolError("El texto a sustituir está vacío.");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new ToolError(`No se pudo leer el archivo: ${(err as Error).message}`);
  }
  const crlf =
    text.includes("\r\n") && text.split("\r\n").length - 1 === text.split("\n").length - 1;
  let search = oldText;
  let replacement = newText;
  if (crlf) {
    text = text.replace(/\r\n/g, "\n");
    search = search.replace(/\r\n/g, "\n");
    replacement = replacement.replace(/\r\n/g, "\n");
  }
  const parts = text.split(search);
  const count = parts.length - 1;
  if (count === 0) {
    throw new ToolError("No se encontró el texto indicado en el archivo.");
  }
  let updated = parts.join(replacement);
  if (crlf) updated = updated.replace(/\n/g, "\r\n");
  try {
    fs.writeFileSync(file, updated, "utf-8");
  } catch (err) {
    throw new ToolError(`No se pudo escribir: ${(err as Error).message}`);
  }
  const rel = toRelativePosix(root, file);
  return [
    `Actualizado ${rel}: ${count} sustitución(es).`,
    `editar · ${rel} (${count} cambio${count !== 1 ? "s" : ""})`,
  ];
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  root: string
): [string, string] {
  if (name === "list_files") return listFiles(root, String(args.path || ""));
  if (name === "read_file") return readFile(root, String(args.path || ""));
  if (name === "write_file") {
    return writeFile(root, String(args.path || ""), String(args.content || ""));
  }
  if (name === "replace_in_file") {
    return replaceInFile(
      root,
      String(args.path || ""),
      String(args.old || ""),
      String(args.new || "")
    );
  }
  throw new ToolError(`Herramienta desconocida: ${name}`);
}

export function describeTool(name: string, args: Record<string, unknown>): string {
  const p = String(args.path || "").trim() || ".";
  if (name === "write_file") {
    const content = String(args.content || "");
    return `${p} (${formatSize(Buffer.byteLength(content, "utf-8"))})`;
  }
  return p;
}

export function systemPrompt(root: string): string {
  return (
    `Eres un asistente de programación que trabaja dentro del proyecto ubicado en ${root}.\n` +
    "Puedes listar, leer, crear y modificar archivos con las herramientas disponibles. " +
    "Trabaja únicamente dentro de esa carpeta y no escribas en .git.\n" +
    "Reglas: lee un archivo antes de editarlo; para cambios pequeños usa " +
    "replace_in_file y para archivos nuevos o reescrituras completas usa write_file; " +
    "no inventes el contenido de archivos que no has leído. " +
    "Responde en el mismo idioma que el usuario. Al terminar, resume qué archivos " +
    "has cambiado y qué has hecho."
  );
}
