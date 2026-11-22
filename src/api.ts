import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "./types.ts";
import type { ChatMessage } from "./types.ts";

export const BASE = "https://openrouter.ai/api/v1";
export const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const UA = `AIHub/${APP_VERSION} (Node; +https://openrouter.ai)`;

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

function buildHeaders(key?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/json",
    "Content-Type": "application/json",
    "HTTP-Referer": "https://localhost/ai-hub",
    "X-Title": "AI Hub",
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function formatHttpError(status: number, body: string): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error;
    if (err && typeof err === "object" && err.message) {
      message = String(err.message);
    } else if (typeof err === "string") {
      message = err;
    } else if (parsed?.message) {
      message = String(parsed.message);
    }
  } catch {
    // raw body
  }
  const low = message.toLowerCase();
  if (
    status === 429 &&
    (low.includes("free-models-per-day") ||
      low.includes("free model requests per day") ||
      (low.includes("free") && low.includes("per day") && low.includes("rate limit")))
  ) {
    return (
      "Has agotado el límite diario de peticiones a modelos gratuitos de " +
      "OpenRouter (el modelo es gratis, pero las peticiones están topadas). " +
      "Se renueva mañana; o añade 10 $ de saldo para desbloquear 1000 " +
      `peticiones gratis al día. (HTTP ${status}: ${message.slice(0, 220)})`
    );
  }
  const noCreditsWords = [
    "no credits remaining",
    "no credit",
    "insufficient quota",
    "insufficient_quota",
    "exceeded your current quota",
    "quota exceeded",
    "credit balance is too low",
    "billing",
    "add credits",
    "payment required",
  ];
  if ((status === 402 || status === 429) && noCreditsWords.some((w) => low.includes(w))) {
    return (
      "Tu cuenta de este proveedor no tiene saldo/créditos. " +
      "Añade crédito en su panel de facturación o elige otro modelo. " +
      `(HTTP ${status}: ${message.slice(0, 240)})`
    );
  }
  const hints: Record<number, string> = {
    401: "Clave no válida o revocada: revísala en Ajustes.",
    402: "Sin saldo para este modelo. Añade crédito o usa uno gratis.",
    429: "Demasiadas peticiones seguidas: espera unos segundos y reintenta.",
  };
  if (hints[status]) {
    return `${hints[status]} (HTTP ${status}: ${message.slice(0, 180)})`;
  }
  return `HTTP ${status}: ${message.slice(0, 500)}`;
}

export async function requestJson<T = Record<string, unknown>>(
  url: string,
  payload?: Record<string, unknown> | null,
  key?: string | null,
  timeoutMs = 60_000,
  method?: string
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: method || (payload ? "POST" : "GET"),
      headers: buildHeaders(key),
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ApiError(formatHttpError(res.status, text));
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("La respuesta del servidor no es JSON. Revisa la URL del proveedor.");
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ApiError("La petición ha tardado demasiado (timeout).");
    }
    throw new ApiError(`Sin conexión: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkOpenRouter(key: string): Promise<Record<string, unknown>> {
  if (!key) {
    return { ok: false, reason: "missing", message: "Falta la clave de OpenRouter." };
  }
  try {
    const data = await requestJson<{ data?: Record<string, unknown> }>(
      `${BASE}/key`,
      null,
      key,
      20_000
    );
    const info = (data.data || {}) as Record<string, unknown>;
    const free = (info.free_model_daily_requests || {}) as Record<string, unknown>;
    const result: Record<string, unknown> = {
      ok: true,
      reason: "ok",
      message: "",
      label: String(info.label || ""),
      limit: info.limit ?? null,
      remaining: info.limit_remaining ?? null,
      free_used: free.used ?? null,
      free_limit: free.limit ?? null,
      free_remaining: free.remaining ?? null,
    };
    try {
      const credits = await requestJson<{ data?: Record<string, unknown> }>(
        `${BASE}/credits`,
        null,
        key,
        20_000
      );
      const payload = credits.data || {};
      if (payload.total_credits != null && payload.total_usage != null) {
        result.credits = Number((Number(payload.total_credits) - Number(payload.total_usage)).toFixed(4));
        result.total_usage = Number(Number(payload.total_usage).toFixed(4));
      }
    } catch {
      // credits info is optional
    }
    return result;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof ApiError ? "invalid" : "error",
      message: (err as Error).message,
    };
  }
}

export async function openrouterModelsText(): Promise<Array<Record<string, unknown>>> {
  const data = await requestJson<{ data?: unknown }>(`${BASE}/models`, null, null, 45_000);
  return Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
}

export async function openrouterModelsImage(): Promise<Array<Record<string, unknown>>> {
  const data = await requestJson<{ data?: unknown }>(`${BASE}/images/models`, null, null, 45_000);
  return Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
}

export async function openrouterModelsVideo(): Promise<Array<Record<string, unknown>>> {
  const data = await requestJson<{ data?: unknown }>(`${BASE}/videos/models`, null, null, 45_000);
  return Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
}

export async function imageEndpointPrices(
  modelIds: string[],
  concurrency = 8
): Promise<Record<string, { price: number; unit: string }>> {
  const result: Record<string, { price: number; unit: string }> = {};
  let index = 0;

  async function worker(): Promise<void> {
    while (index < modelIds.length) {
      const modelId = modelIds[index++];
      try {
        const quoted = encodeURIComponent(modelId).replace(/%2F/g, "/").replace(/%3A/g, ":");
        const data = await requestJson<{ endpoints?: Array<Record<string, unknown>> }>(
          `${BASE}/images/models/${quoted}/endpoints`,
          null,
          null,
          15_000
        );
        let best: { price: number; unit: string } | null = null;
        for (const ep of data.endpoints || []) {
          const pricing = Array.isArray(ep.pricing) ? ep.pricing : [];
          for (const line of pricing as Array<Record<string, unknown>>) {
            if (!["output_image", "output_image_edit"].includes(String(line.billable || ""))) {
              continue;
            }
            const cost = Number(line.cost_usd || 0);
            if (!Number.isFinite(cost) || cost <= 0) continue;
            const unit = String(line.unit || "image");
            if (!best || cost < best.price) {
              best = { price: cost, unit };
            }
          }
        }
        if (best) result[modelId] = best;
      } catch {
        // ignore individual endpoint failures
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, modelIds.length) }, () => worker());
  await Promise.all(workers);
  return result;
}

export function videoPrices(skus: unknown): [number | null, string] {
  if (!skus || typeof skus !== "object" || Array.isArray(skus)) return [null, ""];
  const candidates: Array<[number, number]> = [];
  const tags = ["480p", "720p", "1080p", "768p", "360p", "2k", "4k"];
  for (const [name, raw] of Object.entries(skus as Record<string, unknown>)) {
    const key = name.toLowerCase();
    let value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!key.includes("second") && !key.includes("duration")) continue;
    if (key.includes("cents")) value /= 100;
    let pref = 9;
    for (let i = 0; i < tags.length; i++) {
      if (key.includes(tags[i])) {
        pref = i;
        break;
      }
    }
    if (key.includes("long_") || key.includes("reference")) pref += 10;
    candidates.push([pref, value]);
  }
  if (!candidates.length) return [null, ""];
  candidates.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]));
  return [candidates[0][1], "s"];
}

export async function ollamaTags(): Promise<Array<Record<string, unknown>>> {
  try {
    const data = await requestJson<{ models?: unknown }>(`${OLLAMA}/api/tags`, null, null, 2_000);
    return Array.isArray(data.models) ? (data.models as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

export async function streamOllamaChat(
  model: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<Record<string, number>> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
  } catch {
    throw new ApiError(
      "No se puede conectar con Ollama. Abre la app de Ollama o ejecuta 'ollama serve'."
    );
  }
  if (!res.ok) {
    throw new ApiError(formatHttpError(res.status, await res.text()));
  }
  const reader = res.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let buffer = "";
  let stats: Record<string, number> = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.error) throw new ApiError(String(obj.error));
      const msg = obj.message as Record<string, unknown> | undefined;
      const delta = String(msg?.content || "");
      if (delta) onDelta(delta);
      if (obj.done) {
        stats = {
          prompt_tokens: Number(obj.prompt_eval_count || 0),
          completion_tokens: Number(obj.eval_count || 0),
          eval_duration: Number(obj.eval_duration || 0) / 1e9,
        };
      }
    }
  }
  return stats;
}

export async function chatOllamaTools(
  model: string,
  messages: ChatMessage[],
  tools: unknown[]
): Promise<Record<string, unknown>> {
  const outgoing = messages.map((msg) => {
    const copy: Record<string, unknown> = { ...msg, content: msg.content || "" };
    if (Array.isArray(msg.tool_calls)) {
      copy.tool_calls = msg.tool_calls.map((call) => {
        const fn = { ...((call.function || {}) as Record<string, unknown>) };
        if (typeof fn.arguments === "string") {
          try {
            fn.arguments = JSON.parse(fn.arguments || "{}");
          } catch {
            fn.arguments = {};
          }
        }
        return { function: fn };
      });
    }
    return copy;
  });
  const data = await requestJson<Record<string, unknown>>(
    `${OLLAMA}/api/chat`,
    { model, messages: outgoing, tools, stream: false },
    null,
    300_000
  );
  const message = (data.message || {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const calls = rawCalls.map((call, idx) => {
    const fn = ((call as Record<string, unknown>).function || {}) as Record<string, unknown>;
    const args = fn.arguments || {};
    return {
      id: `call_${idx}`,
      type: "function",
      function: {
        name: String(fn.name || ""),
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    };
  });
  const outMsg: Record<string, unknown> = {
    role: "assistant",
    content: String(message.content || ""),
  };
  if (calls.length) outMsg.tool_calls = calls;
  return {
    choices: [{ message: outMsg }],
    usage: {
      prompt_tokens: Number(data.prompt_eval_count || 0),
      completion_tokens: Number(data.eval_count || 0),
      eval_duration: Number(data.eval_duration || 0) / 1e9,
    },
  };
}

function extractDeltaText(delta: Record<string, unknown>): string {
  const content = delta.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
      .map((part) => String((part as Record<string, unknown>).text || ""))
      .join("");
  }
  return "";
}

export async function chatTools(
  key: string,
  model: string,
  messages: ChatMessage[],
  tools: unknown[],
  base = BASE
): Promise<Record<string, unknown>> {
  if (!key) throw new ApiError("Falta la clave de OpenRouter. Configúrala en Ajustes.");
  return requestJson<Record<string, unknown>>(
    `${base.replace(/\/+$/, "")}/chat/completions`,
    { model, messages, tools, tool_choice: "auto" },
    key,
    300_000
  );
}

export async function streamOpenRouterChat(
  key: string,
  model: string,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  base = BASE,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  if (!key) throw new ApiError("Falta la clave de OpenRouter. Configúrala en Ajustes.");
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(key),
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") return {};
    throw new ApiError(`Sin conexión con OpenRouter: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ApiError(formatHttpError(res.status, await res.text()));
  }
  const reader = res.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Record<string, unknown> = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return usage;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (obj.error) {
        const err = obj.error as Record<string, unknown> | string;
        throw new ApiError(typeof err === "string" ? err : String(err.message || "Error de API"));
      }
      if (obj.usage && typeof obj.usage === "object") {
        usage = obj.usage as Record<string, unknown>;
      }
      const choices = Array.isArray(obj.choices) ? obj.choices : [];
      if (!choices.length) continue;
      const delta = ((choices[0] as Record<string, unknown>).delta || {}) as Record<string, unknown>;
      const text = extractDeltaText(delta);
      if (text) onDelta(text);
    }
  }
  return usage;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
};

function slugModel(text: string): string {
  const clean = text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean.slice(-60) || "modelo";
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}

export async function generateImage(
  key: string,
  model: string,
  prompt: string,
  outDir: string,
  aspectRatio?: string | null
): Promise<{ filePath: string; cost: number | null; media: string }> {
  if (!key) throw new ApiError("Falta la clave de OpenRouter. Configúrala en Ajustes.");
  const payload: Record<string, unknown> = { model, prompt, n: 1 };
  if (aspectRatio) payload.aspect_ratio = aspectRatio;
  const data = await requestJson<Record<string, unknown>>(`${BASE}/images`, payload, key, 600_000);
  const items = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
  if (!items.length) throw new ApiError("La API no devolvió ninguna imagen.");
  const item = items[0];
  const encoded = String(item.b64_json || "");
  if (!encoded) throw new ApiError("Respuesta de imagen sin datos (b64_json).");
  const media = String(item.media_type || "image/png");
  const ext = MIME_EXT[media] || "png";
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${timestamp()}-${slugModel(model)}.${ext}`);
  fs.writeFileSync(filePath, Buffer.from(encoded, "base64"));
  const rawCost = (data.usage as Record<string, unknown> | undefined)?.cost;
  const cost = rawCost != null && Number.isFinite(Number(rawCost)) ? Number(rawCost) : null;
  return { filePath, cost, media };
}

export async function generateImageOpenAI(
  base: string,
  key: string,
  model: string,
  prompt: string,
  outDir: string
): Promise<{ filePath: string; cost: number | null; media: string }> {
  if (!key) throw new ApiError("Falta la clave del proveedor. Configúrala al añadirlo.");
  const data = await requestJson<Record<string, unknown>>(
    `${base.replace(/\/+$/, "")}/images/generations`,
    { model, prompt, n: 1 },
    key,
    600_000
  );
  const items = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
  if (!items.length) throw new ApiError("La API no devolvió ninguna imagen.");
  const item = items[0];
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${timestamp()}-${slugModel(model)}.png`);
  if (item.b64_json) {
    fs.writeFileSync(filePath, Buffer.from(String(item.b64_json), "base64"));
  } else if (item.url) {
    const res = await fetch(String(item.url));
    if (!res.ok) throw new ApiError(`No se pudo descargar la imagen (HTTP ${res.status}).`);
    fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  } else {
    throw new ApiError("Respuesta de imagen sin datos.");
  }
  return { filePath, cost: null, media: "image/png" };
}

export async function generateVideo(
  key: string,
  model: string,
  prompt: string,
  outDir: string,
  opts: { duration?: number | null; resolution?: string | null; aspectRatio?: string | null } = {}
): Promise<string> {
  if (!key) throw new ApiError("Falta la clave de OpenRouter. Configúrala en Ajustes.");
  const payload: Record<string, unknown> = { model, prompt };
  if (opts.duration) payload.duration = opts.duration;
  if (opts.resolution) payload.resolution = opts.resolution;
  if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;

  const job = await requestJson<Record<string, unknown>>(`${BASE}/videos`, payload, key, 120_000);
  const jobId = job.id;
  if (!jobId) throw new ApiError("La API no devolvió un id de trabajo.");
  let pollUrl = String(job.polling_url || "");
  if (pollUrl.startsWith("/")) pollUrl = `https://openrouter.ai${pollUrl}`;
  let status = job;
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const state = String(status.status || "");
    if (state === "completed") break;
    if (["failed", "cancelled", "expired"].includes(state)) {
      throw new ApiError(`El vídeo terminó en estado '${state}': ${status.error || ""}`);
    }
    if (!pollUrl) throw new ApiError("La API no devolvió polling_url.");
    await new Promise((r) => setTimeout(r, 4000));
    status = await requestJson<Record<string, unknown>>(pollUrl, null, key, 90_000, "GET");
  }
  if (String(status.status || "") !== "completed") {
    throw new ApiError("Tiempo de espera agotado generando el vídeo.");
  }
  const url = `${BASE}/videos/${encodeURIComponent(String(jobId))}/content?index=0`;
  const res = await fetch(url, { headers: buildHeaders(key) });
  if (!res.ok) throw new ApiError(formatHttpError(res.status, await res.text()));
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, `${timestamp()}-${slugModel(model)}.mp4`);
  fs.writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  return filePath;
}
