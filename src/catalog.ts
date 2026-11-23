import fs from "node:fs";
import * as api from "./api.ts";
import * as config from "./config.ts";
import { APP_VERSION } from "./types.ts";
import type {
  ModelData,
  ModelGroup,
  ModelGroupInfo,
  ModelPayload,
  ProviderInfo,
  UserConfig,
} from "./types.ts";

export const CACHE_VERSION = 4;

export const MODEL_GROUPS: ModelGroupInfo[] = [
  { id: "code", label: "Programación", short_label: "Código", icon: "⌘" },
  { id: "reasoning", label: "Razonamiento", short_label: "Razona", icon: "◈" },
  { id: "vision", label: "Visión y multimodal", short_label: "Visión", icon: "◉" },
  { id: "chat", label: "Chat y texto", short_label: "Chat", icon: "✦" },
  { id: "image", label: "Imagen", short_label: "Imagen", icon: "◫" },
  { id: "video", label: "Vídeo", short_label: "Vídeo", icon: "▶" },
];

const GROUP_LABELS: Record<ModelGroup, string> = Object.fromEntries(
  MODEL_GROUPS.map((g) => [g.id, g.label])
) as Record<ModelGroup, string>;

// Todos los proveedores (incluidos OpenRouter, Ollama y OpenCode) se añaden
// desde Ajustes → Proveedores y se guardan en el disco duro de cada usuario.
export const BASE_PROVIDERS: ProviderInfo[] = [];

const CLAUDE_ALIASES: Array<[string, string, string, number, number, string]> = [
  [
    "haiku",
    "Claude Haiku 5.5",
    "anthropic/claude-haiku-5.5",
    0.1,
    0.5,
    "El más rápido y barato de Anthropic. Ideal para tareas sencillas y ediciones rápidas.",
  ],
  [
    "sonnet",
    "Claude Sonnet 5.5",
    "anthropic/claude-sonnet-5.5",
    2.0,
    10.0,
    "Equilibrio entre calidad y precio. El modelo recomendado para programar con Claude Code.",
  ],
  [
    "opus",
    "Claude Opus 5.5",
    "anthropic/claude-opus-5.5",
    4.0,
    20.0,
    "El más capaz para código complejo, aunque cuesta el doble que Sonnet.",
  ],
  [
    "fable",
    "Claude Fable 5.2",
    "anthropic/claude-fable-5.2",
    8.0,
    40.0,
    "Modelo premium de la familia Mythos. Solo para trabajos que necesiten lo máximo.",
  ],
];

const OLLAMA_CURATED: Array<[string, string, string]> = [
  [
    "qwen2.5-coder:1.5b",
    "Programación · ultrarrápido, 1 GB",
    "Ideal para autocompletar y preguntas rápidas en un portátil.",
  ],
  [
    "qwen2.5-coder:7b",
    "Programación · equilibrio, 4,7 GB",
    "Muy bueno en código para su tamaño; cabe en 8 GB de RAM.",
  ],
  [
    "qwen3-coder:30b",
    "Programación · potente, ~19 GB",
    "Nivel avanzado si tienes una GPU con suficiente VRAM.",
  ],
  [
    "deepseek-coder-v2:16b",
    "Programación · 8,9 GB",
    "Fuerte en lenguajes de programación y refactorización.",
  ],
  ["llama3.2:3b", "General · ligero, 2 GB", "Rápido para chat general y tareas de texto."],
  [
    "gemma3:4b",
    "General · multimodal, 3,3 GB",
    "Acepta imágenes y texto; buena relación tamaño/calidad.",
  ],
  ["phi4:14b", "Razonamiento · 9,1 GB", "Buen razonamiento matemático y técnico en local."],
  ["deepseek-r1:8b", "Razonamiento · 4,9 GB", "Modelo de razonamiento paso a paso en local."],
  ["mistral:7b", "General · 4,4 GB", "Clásico fiable para tareas generales."],
  ["codellama:7b", "Programación · 3,8 GB", "Especializado en código, ligero y veterano."],
  ["starcoder2:7b", "Programación · 4 GB", "Entrenado con código; bueno para completar funciones."],
  [
    "llava:7b",
    "Visión · 4,7 GB",
    "Analiza imágenes (no genera): describe, extrae texto, responde preguntas.",
  ],
  [
    "llama3.2-vision:11b",
    "Visión · 7,9 GB",
    "Analiza imágenes y documentos con buena calidad.",
  ],
  [
    "qwen2.5vl:7b",
    "Visión · 6 GB",
    "Visión y OCR potentes, también para capturas de pantalla.",
  ],
  ["moondream:latest", "Visión · 1,7 GB", "Visión muy ligera para describir imágenes rápido."],
];

const IMAGE_UNIT: Record<string, string> = {
  image: "imagen",
  megapixel: "MP",
  token: "1M tokens",
};

function trimZeros(num: number, decimals: number): string {
  return num.toFixed(decimals).replace(/\.?0+$/, "");
}

export function fmtUsd(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value === 0) return "0";
  if (value < 0.0001) return trimZeros(value, 6);
  if (value < 0.01) return trimZeros(value, 4);
  if (value < 1) return trimZeros(value, 3);
  return trimZeros(value, 2);
}

export function fmtContext(tokens: number | null | undefined): string {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) return `${trimZeros(tokens / 1_000_000, 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function humanSize(numBytes: unknown): string {
  const n = Number(numBytes || 0);
  if (!n) return "";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`.replace(".", ",");
  return `${Math.round(gb * 1024)} MB`;
}

export function effectivePrice(model: ModelData): number | null {
  if (model.category === "code") {
    if (model.p_out) return model.p_out;
    if (model.p_in) return model.p_in;
    if (model.free) return 0;
    return model.price;
  }
  return model.price;
}

export function priceText(model: ModelData): string {
  if (model.free) return "Gratis";
  if (model.extra?.custom_paid) return "de pago";
  if (model.extra?.variable_price) return "variable";
  if (model.category === "code") {
    const hasIn = model.p_in != null;
    const hasOut = model.p_out != null;
    if (hasIn && hasOut) {
      if (!model.p_in && !model.p_out) return "por petición";
      return `$${fmtUsd(model.p_in)} / $${fmtUsd(model.p_out)}`;
    }
    const eff = effectivePrice(model);
    if (eff != null) return `$${fmtUsd(eff)}`;
    return "—";
  }
  if (model.price == null) {
    if (model.extra?.token_price) return "por tokens";
    return "—";
  }
  if (model.unit === "imagen") return `$${fmtUsd(model.price)} / imagen`;
  if (model.unit === "s") return `$${fmtUsd(model.price)} / s`;
  if (model.unit === "MP") return `$${fmtUsd(model.price)} / MP`;
  return `$${fmtUsd(model.price)}`;
}

export function priceDetail(model: ModelData): string {
  if (model.provider === "ollama") return "Local y gratis · usa tu propio hardware";
  if (model.free) return "Gratis · 0 $ por millón de tokens";
  if (model.category === "code") {
    if (model.extra?.variable_price) {
      return "Precio variable: el router elige el modelo y cobra el de ese modelo";
    }
    if (model.p_in == null && model.p_out == null) {
      return "Precio no disponible en el catálogo local";
    }
    if (!model.p_in && !model.p_out) {
      const perReq = Number(model.extra?.per_request || 0);
      if (perReq) return `Se cobra por petición: $${fmtUsd(perReq)} cada una`;
      return "Se cobra por petición, no por token";
    }
    return `Entrada $${fmtUsd(model.p_in)} · Salida $${fmtUsd(model.p_out)} por 1M tokens`;
  }
  if (model.category === "image") {
    if (model.price == null) {
      const tp = Number(model.extra?.token_price || 0);
      if (tp) {
        return `$${fmtUsd(tp)} por token de imagen · el coste real depende de la resolución`;
      }
      return "Precio por imagen aún sin calcular";
    }
    if (model.unit === "MP") return `$${fmtUsd(model.price)} por megapíxel generado`;
    return `$${fmtUsd(model.price)} por imagen generada`;
  }
  if (model.category === "video") {
    if (model.price == null) {
      return "Precio por segundo no disponible (se factura por tokens)";
    }
    const seconds = Number(model.extra?.sample_duration || 4);
    const estimate = model.price * seconds;
    return `≈ $${fmtUsd(model.price)} por segundo · ${seconds}s ≈ $${fmtUsd(estimate)}`;
  }
  return "";
}

export function infoText(model: ModelData): string {
  const bits: string[] = [];
  if (model.provider === "opencode") {
    const map: Record<string, string> = {
      openrouter: "OpenRouter",
      "console-openrouter": "Console",
      opencode: "Zen",
      google: "Google",
      groq: "Groq",
    };
    const gw = map[String(model.extra?.gateway || "")];
    if (gw) bits.push(gw);
  }
  if (model.provider === "ollama") {
    if (model.extra?.installed) {
      const sz = humanSize(model.extra?.size);
      bits.push(sz ? `Instalado · ${sz}` : "Instalado");
    } else {
      bits.push("Descargable");
    }
  }
  if (model.category === "code" && model.context) {
    bits.push(`${fmtContext(model.context)} ctx`);
  }
  if (model.category === "image") {
    const ratios = (model.extra?.aspect_ratios as string[]) || [];
    if (ratios.length) bits.push(ratios.slice(0, 3).join(" · "));
  }
  if (model.category === "video") {
    const res = (model.extra?.resolutions as string[]) || [];
    const durations = (model.extra?.durations as number[]) || [];
    if (res.length) {
      const order = ["360p", "480p", "540p", "720p", "1080p", "1440p", "2K", "4K"];
      const best = [...res].sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
      if (best) bits.push(best);
    }
    if (durations.length) bits.push(`${Math.max(...durations)}s`);
  }
  if (model.provider === "claude") {
    bits.push(`alias: ${String(model.extra?.alias || model.uid)}`);
  }
  if (!bits.length) bits.push(model.unit);
  return bits.join(" · ");
}

const SIZE_RE = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g;
const TOP_FAMILIES = [
  "deepseek",
  "qwen",
  "glm",
  "kimi",
  "minimax",
  "llama",
  "mistral",
  "mixtral",
  "gemma",
  "gpt",
  "gemini",
  "claude",
  "phi",
  "nemotron",
  "seed",
  "hunyuan",
  "ernie",
  "ling",
  "command",
  "grok",
];
const ROUTER_WORDS = ["router", "auto", "fusion", "switchyard", "free models"];

const CODE_GROUP_RE =
  /(coder|codestral|devstral|codellama|starcoder|codegeex|magicoder|granite-code|yi-coder|\bswe[-_]|-code\b|\bcode-)/i;
const REASONING_GROUP_RE =
  /(deepseek-r1|(?<![a-z0-9])(o1|o3|o4|r1|qwq|qvq)(?![a-z0-9])|reason|thinking|thought|phi-?4|magistral|nemotron.*ultra)/i;
const VISION_GROUP_RE =
  /(vision|llava|pixtral|moondream|internvl|molmo|(?<![a-z0-9])vl(?![a-z0-9])|-vl\b|\bvl-|qwen[0-9.]*vl|multimodal|gemma3)/i;

export function classifyGroup(model: ModelData): ModelGroup {
  if (model.category === "image") return "image";
  if (model.category === "video") return "video";

  const text = `${model.uid} ${model.name}`.toLowerCase();
  const tagsLow = (model.tags || []).map((t) => String(t).toLowerCase());

  if (
    model.provider === "claude" ||
    model.provider === "opencode" ||
    tagsLow.some((t) => t.includes("programación") || t.includes("código")) ||
    CODE_GROUP_RE.test(text)
  ) {
    return "code";
  }

  if (
    tagsLow.some((t) => t.includes("razonamiento")) ||
    REASONING_GROUP_RE.test(text)
  ) {
    return "reasoning";
  }

  if (
    tagsLow.some((t) => t.includes("visión") || t.includes("vision") || t.includes("multimodal")) ||
    VISION_GROUP_RE.test(text)
  ) {
    return "vision";
  }

  return "chat";
}

export function relevanceScore(model: ModelData): number {
  let score = 0;
  const ctx = model.context || 0;
  if (ctx > 0) score += Math.min(ctx / 200_000, 1) * 35;

  const tags = new Set((model.tags || []).map((t) => String(t).toLowerCase()));
  if (tags.has("herramientas")) score += 12;
  if (tags.has("visión") || tags.has("vision")) score += 8;
  if (tags.has("razonamiento")) score += 6;
  if (tags.has("edición")) score += 8;
  if (tags.has("con audio")) score += 8;
  if (tags.has("imagen→vídeo")) score += 8;

  if (model.provider === "ollama" && model.extra?.installed) {
    score += 25;
  }

  if (model.category === "image") {
    const ratios = (model.extra?.aspect_ratios as string[]) || [];
    if (ratios.length) score += Math.min(ratios.length, 6) * 2;
  } else if (model.category === "video") {
    const res = (model.extra?.resolutions as string[]) || [];
    if (res.some((r) => /4k|1080p/i.test(r))) score += 10;
    else if (res.some((r) => /720p/i.test(r))) score += 5;
  }

  const text = `${model.name} ${model.uid}`.toLowerCase();
  const sizes: number[] = [];
  for (const match of text.matchAll(SIZE_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) sizes.push(n);
  }
  if (sizes.length) {
    const maxSize = Math.max(...sizes);
    score += Math.min(maxSize / 70, 1) * 16;
    if (maxSize < 3) score -= 6;
  }

  if (TOP_FAMILIES.some((family) => text.includes(family))) score += 10;
  if (ROUTER_WORDS.some((word) => text.includes(word))) score -= 18;

  const created = Number(model.extra?.created || 0);
  if (Number.isFinite(created) && created > 0) {
    const ageDays = Math.max(0, (Date.now() / 1000 - created) / 86400);
    score += Math.max(0, 1 - ageDays / 400) * 8;
  }

  return Number(score.toFixed(2));
}

export function modelPayload(model: ModelData, provider?: ProviderInfo): ModelPayload {
  const group = classifyGroup(model);
  return {
    ...model,
    group,
    group_label: GROUP_LABELS[group] || "Chat y texto",
    price_text: priceText(model),
    price_detail: priceDetail(model),
    context_text: fmtContext(model.context),
    info_text: infoText(model),
    effective_price: effectivePrice(model),
    provider_name: provider?.name || model.provider,
    provider_color: provider?.color || "#8b93a7",
    provider_glyph: provider?.glyph || "◆",
    relevance_score: relevanceScore(model),
  };
}

interface CacheFile {
  version: number;
  app_version: string;
  providers: Record<string, { ts: number; models: ModelData[] }>;
  image_prices: { ts?: number; data?: Record<string, { price: number; unit: string }> };
}

const memoryCache = new Map<string, CacheFile>();

function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, app_version: APP_VERSION, providers: {}, image_prices: {} };
}

function getCache(): CacheFile {
  const key = config.cachePath();
  const existing = memoryCache.get(key);
  if (existing) return existing;
  try {
    const raw = JSON.parse(fs.readFileSync(key, "utf-8"));
    if (raw && raw.version === CACHE_VERSION && raw.app_version === APP_VERSION) {
      raw.providers = raw.providers || {};
      raw.image_prices = raw.image_prices || {};
      memoryCache.set(key, raw as CacheFile);
      return raw as CacheFile;
    }
  } catch {
    // ignore
  }
  const fresh = emptyCache();
  memoryCache.set(key, fresh);
  return fresh;
}

function writeCache(data: CacheFile): void {
  try {
    fs.mkdirSync(config.appDir(), { recursive: true });
    const target = config.cachePath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
    fs.renameSync(tmp, target);
  } catch {
    // ignore cache write error
  }
}

export function storeModels(provider: string, models: ModelData[]): void {
  const data = getCache();
  data.providers[provider] = { ts: Date.now() / 1000, models };
  writeCache(data);
}

export function cachedModels(provider: string): { models: ModelData[]; ts: number | null } {
  const entry = getCache().providers[provider];
  if (!entry) return { models: [], ts: null };
  return { models: Array.isArray(entry.models) ? entry.models : [], ts: entry.ts ?? null };
}

function cachedImagePrices(): Record<string, { price: number; unit: string }> {
  return getCache().image_prices?.data || {};
}

function storeImagePrices(prices: Record<string, { price: number; unit: string }>): void {
  const data = getCache();
  data.image_prices = { ts: Date.now() / 1000, data: prices };
  writeCache(data);
}

function cleanDesc(text: unknown, limit = 420): string {
  if (!text) return "";
  let value = String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length > limit) value = `${value.slice(0, limit).trimEnd()}…`;
  return value;
}

function toNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function displayName(name: string): string {
  const clean = name.split(/\s+/).join(" ");
  const idx = clean.indexOf(": ");
  if (idx === -1) return clean;
  const prefix = clean.slice(0, idx);
  const rest = clean.slice(idx + 2);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const pk = norm(prefix);
  if (pk.length >= 3 && norm(rest).startsWith(pk)) return rest;
  return clean;
}

export function buildOpenRouterText(raw: Array<Record<string, unknown>>): ModelData[] {
  const models: ModelData[] = [];
  for (const item of raw) {
    const uid = String(item.id || "").trim();
    if (!uid || uid.endsWith(":batch")) continue;
    const arch = (item.architecture || {}) as Record<string, unknown>;
    const outputs = Array.isArray(arch.output_modalities)
      ? (arch.output_modalities as string[])
      : ["text"];
    if (outputs.some((k) => ["image", "video", "audio"].includes(k))) continue;
    const pricing = (item.pricing || {}) as Record<string, unknown>;
    const rawIn = toNum(pricing.prompt);
    const rawOut = toNum(pricing.completion);
    const perRequest = toNum(pricing.request) || 0;
    const pIn = rawIn == null || rawIn < 0 ? null : Number((rawIn * 1_000_000).toFixed(6));
    const pOut = rawOut == null || rawOut < 0 ? null : Number((rawOut * 1_000_000).toFixed(6));
    const free = pIn === 0 && pOut === 0 && perRequest <= 0;
    const variable = (rawIn != null && rawIn < 0) || (rawOut != null && rawOut < 0);
    const supported = Array.isArray(item.supported_parameters)
      ? (item.supported_parameters as string[])
      : [];
    const inputs = Array.isArray(arch.input_modalities)
      ? (arch.input_modalities as string[])
      : ["text"];
    const tags: string[] = [];
    if (free) tags.push("gratis");
    if (item.reasoning) tags.push("razonamiento");
    if (supported.includes("tools")) tags.push("herramientas");
    if (inputs.includes("image")) tags.push("visión");
    if (uid.endsWith(":free")) tags.push("free");
    models.push({
      provider: "openrouter",
      uid,
      name: displayName(String(item.name || uid)),
      category: "code",
      free,
      p_in: pIn,
      p_out: pOut,
      price: pOut || pIn,
      unit: "1M tokens",
      context: toNum(item.context_length),
      desc: cleanDesc(item.description),
      tags,
      extra: {
        modality: arch.modality,
        per_request: perRequest,
        variable_price: variable,
        created: item.created,
      },
    });
  }
  return models;
}

export function buildOpenRouterImages(raw: Array<Record<string, unknown>>): ModelData[] {
  const models: ModelData[] = [];
  for (const item of raw) {
    const uid = String(item.id || "").trim();
    if (!uid) continue;
    const arch = (item.architecture || {}) as Record<string, unknown>;
    const params = (item.supported_parameters || {}) as Record<string, unknown>;
    const aspect = (params.aspect_ratio || {}) as Record<string, unknown>;
    const ratios = Array.isArray(aspect.values) ? (aspect.values as string[]) : [];
    const inputs = Array.isArray(arch.input_modalities)
      ? (arch.input_modalities as string[])
      : ["text"];
    const tags = ["imagen"];
    if (inputs.includes("image")) tags.push("edición");
    if (item.supports_streaming) tags.push("streaming");
    models.push({
      provider: "openrouter",
      uid,
      name: displayName(String(item.name || uid)),
      category: "image",
      free: false,
      p_in: null,
      p_out: null,
      price: null,
      unit: "imagen",
      context: null,
      desc: cleanDesc(item.description),
      tags,
      extra: { aspect_ratios: ratios, input_modalities: inputs },
    });
  }
  return models;
}

export function buildOpenRouterVideos(raw: Array<Record<string, unknown>>): ModelData[] {
  const models: ModelData[] = [];
  for (const item of raw) {
    const uid = String(item.id || "").trim();
    const durations = Array.isArray(item.supported_durations)
      ? (item.supported_durations as number[]).filter((d) => typeof d === "number" && d > 0)
      : [];
    if (!uid || !durations.length) continue;
    const [price, unit] = api.videoPrices(item.pricing_skus);
    const resolutions = Array.isArray(item.supported_resolutions)
      ? (item.supported_resolutions as string[])
      : [];
    const aspects = Array.isArray(item.supported_aspect_ratios)
      ? (item.supported_aspect_ratios as string[])
      : [];
    const tags = ["vídeo"];
    if (item.generate_audio) tags.push("con audio");
    if (item.supported_frame_images) tags.push("imagen→vídeo");
    models.push({
      provider: "openrouter",
      uid,
      name: displayName(String(item.name || uid)),
      category: "video",
      free: price === 0,
      p_in: null,
      p_out: null,
      price,
      unit: unit || "s",
      context: null,
      desc: cleanDesc(item.description),
      tags,
      extra: {
        durations,
        resolutions,
        aspect_ratios: aspects,
        sample_duration: Math.min(...durations),
        audio: Boolean(item.generate_audio),
      },
    });
  }
  return models;
}

export function applyImagePrices(
  models: ModelData[],
  prices: Record<string, { price: number; unit: string }>
): void {
  for (const model of models) {
    const info = prices[model.uid];
    if (!info) continue;
    const price = toNum(info.price);
    const unit = String(info.unit || "image");
    if (price == null || price < 0) continue;
    if (unit === "token") {
      model.extra.token_price = price;
      model.price = null;
      model.unit = "tokens";
      continue;
    }
    model.price = price;
    model.unit = IMAGE_UNIT[unit] || "imagen";
    model.free = price === 0;
  }
}

export function buildClaude(textModels: ModelData[]): ModelData[] {
  const byUid = new Map(textModels.map((m) => [m.uid, m]));
  return CLAUDE_ALIASES.map(([alias, name, apiId, fallbackIn, fallbackOut, desc]) => {
    const src = byUid.get(apiId);
    const pIn = src && src.p_in != null ? src.p_in : fallbackIn;
    const pOut = src && src.p_out != null ? src.p_out : fallbackOut;
    return {
      provider: "claude",
      uid: alias,
      name,
      category: "code",
      free: false,
      p_in: pIn,
      p_out: pOut,
      price: pOut,
      unit: "1M tokens",
      context: src?.context || 1_000_000,
      desc,
      tags: ["Anthropic", `alias: ${alias}`],
      extra: { alias, api_id: apiId, live_price: Boolean(src) },
    };
  });
}

export function buildOllama(tags: Array<Record<string, unknown>>): ModelData[] {
  const installed = new Map<string, Record<string, unknown>>();
  for (const item of tags) {
    const name = String(item.name || item.model || "").trim();
    if (name) installed.set(name, item);
  }
  const curatedMap = new Map(OLLAMA_CURATED.map(([n, l, d]) => [n, [l, d] as const]));
  const models: ModelData[] = [];

  for (const [name, item] of installed.entries()) {
    const [label, desc] = curatedMap.get(name) || ["", ""];
    models.push({
      provider: "ollama",
      uid: name,
      name,
      category: "code",
      free: true,
      p_in: 0,
      p_out: 0,
      price: 0,
      unit: "local",
      context: null,
      desc: desc || "Modelo instalado en local con Ollama. Gratis e ilimitado.",
      tags: ["local", "instalado", ...(label ? [label] : [])],
      extra: { installed: true, size: item.size, modified: item.modified_at },
    });
  }

  for (const [name, label, desc] of OLLAMA_CURATED) {
    if (installed.has(name)) continue;
    models.push({
      provider: "ollama",
      uid: name,
      name,
      category: "code",
      free: true,
      p_in: 0,
      p_out: 0,
      price: 0,
      unit: "local",
      context: null,
      desc: `${desc} Se descarga una vez y funciona sin conexión.`,
      tags: ["local", "descargable", ...(label ? [label] : [])],
      extra: { installed: false },
    });
  }
  return models;
}

export async function fetchOpenRouterCatalog(
  providerId: string,
  fetchImagePrices = false,
  persistCache = false
): Promise<ModelData[]> {
  const textRaw = await api.openrouterModelsText();
  const textModels = buildOpenRouterText(textRaw);
  let images: ModelData[] = [];
  let videos: ModelData[] = [];
  try {
    images = buildOpenRouterImages(await api.openrouterModelsImage());
  } catch {
    // image models optional if endpoint fails transiently
  }
  try {
    videos = buildOpenRouterVideos(await api.openrouterModelsVideo());
  } catch {
    // video models optional if endpoint fails transiently
  }
  const existingPrices = persistCache ? cachedImagePrices() : {};
  if (images.length) {
    if (fetchImagePrices || !Object.keys(existingPrices).length) {
      const prices = await api.imageEndpointPrices(images.map((m) => m.uid));
      if (Object.keys(prices).length) {
        applyImagePrices(images, prices);
        if (persistCache) storeImagePrices(prices);
      }
    } else {
      applyImagePrices(images, existingPrices);
    }
  }
  return [...textModels, ...images, ...videos].map((m) => ({
    ...m,
    provider: providerId,
  }));
}

export async function fetchOllamaCatalog(
  providerId: string,
  baseUrl?: string | null
): Promise<ModelData[]> {
  const tags = await api.ollamaTags(baseUrl);
  return buildOllama(tags).map((m) => ({
    ...m,
    provider: providerId,
  }));
}

export async function refreshAll(
  _cfg: UserConfig,
  providers?: string[],
  fetchImagePrices = false,
  persistCache = true
): Promise<Record<string, { models: ModelData[]; error: string | null }>> {
  const wanted = new Set(providers || BASE_PROVIDERS.map((p) => p.id));
  const result: Record<string, { models: ModelData[]; error: string | null }> = {};
  if (!wanted.size) return result;
  let textModels: ModelData[] = [];

  if (wanted.has("openrouter") || wanted.has("claude") || wanted.has("opencode")) {
    try {
      const textRaw = await api.openrouterModelsText();
      textModels = buildOpenRouterText(textRaw);
    } catch (err) {
      if (wanted.has("openrouter")) {
        result.openrouter = {
          models: persistCache ? cachedModels("openrouter").models : [],
          error: (err as Error).message,
        };
      }
    }
  }

  if (wanted.has("openrouter") && textModels.length) {
    let images: ModelData[] = [];
    let videos: ModelData[] = [];
    let openrouterErr: string | null = null;
    try {
      images = buildOpenRouterImages(await api.openrouterModelsImage());
    } catch (err) {
      openrouterErr = (err as Error).message;
    }
    try {
      videos = buildOpenRouterVideos(await api.openrouterModelsVideo());
    } catch (err) {
      openrouterErr = openrouterErr || (err as Error).message;
    }
    const existingPrices = persistCache ? cachedImagePrices() : {};
    if (fetchImagePrices || !Object.keys(existingPrices).length) {
      const prices = await api.imageEndpointPrices(images.map((m) => m.uid));
      if (Object.keys(prices).length) {
        applyImagePrices(images, prices);
        if (persistCache) storeImagePrices(prices);
      }
    } else {
      applyImagePrices(images, existingPrices);
    }
    const all = [...textModels, ...images, ...videos];
    if (persistCache) storeModels("openrouter", all);
    result.openrouter = { models: all, error: openrouterErr };
  }

  if (wanted.has("claude")) {
    const models = buildClaude(textModels);
    if (persistCache) storeModels("claude", models);
    result.claude = { models, error: null };
  }

  if (wanted.has("opencode")) {
    const old = persistCache ? cachedModels("opencode").models : [];
    result.opencode = {
      models: old,
      error: null,
    };
  }

  if (wanted.has("ollama")) {
    const tags = await api.ollamaTags();
    const models = buildOllama(tags);
    if (persistCache) storeModels("ollama", models);
    result.ollama = { models, error: null };
  }

  return result;
}
