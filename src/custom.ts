import * as api from "./api.ts";
import * as catalog from "./catalog.ts";
import type {
  CustomProviderRecord,
  ModelData,
  ProviderInfo,
  ProviderPreset,
  UserConfig,
} from "./types.ts";

export const PRESETS: ProviderPreset[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    glyph: "↗",
    color: "#f2b84b",
    help: "Texto, imagen y vídeo con precios en vivo. Clave en openrouter.ai/keys",
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    base: "http://127.0.0.1:11434/v1",
    glyph: "⬢",
    color: "#4ec9b0",
    help: "Modelos locales 100 % gratis (no necesita clave). Abre Ollama en tu PC.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    base: "https://opencode.ai/zen/v1",
    glyph: "◇",
    color: "#8b7bff",
    help: "OpenCode Zen (compatible con OpenAI). Clave en opencode.ai",
  },
  {
    id: "openai",
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    glyph: "◎",
    color: "#10a37f",
    help: "Clave en platform.openai.com/api-keys",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    glyph: "✦",
    color: "#4285f4",
    help: "Clave en aistudio.google.com/apikey",
  },
  {
    id: "groq",
    name: "Groq",
    base: "https://api.groq.com/openai/v1",
    glyph: "⚡",
    color: "#f55036",
    help: "Clave en console.groq.com/keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    glyph: "◈",
    color: "#4d6bfe",
    help: "Clave en platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    base: "https://api.mistral.ai/v1",
    glyph: "M",
    color: "#fa520f",
    help: "Clave en console.mistral.ai/api-keys",
  },
  {
    id: "together",
    name: "Together AI",
    base: "https://api.together.xyz/v1",
    glyph: "◐",
    color: "#0f6fff",
    help: "Clave en api.together.ai/settings/api-keys",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    base: "https://api.perplexity.ai",
    glyph: "P",
    color: "#20b2aa",
    help: "Clave en perplexity.ai/settings/api",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    base: "https://api.fireworks.ai/inference/v1",
    glyph: "Fw",
    color: "#ff6b35",
    help: "Clave en fireworks.ai/account/api-keys",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    base: "https://api.x.ai/v1",
    glyph: "X",
    color: "#1d1d1f",
    help: "Clave en console.x.ai",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    base: "https://api.cerebras.ai/v1",
    glyph: "Cb",
    color: "#6b46c1",
    help: "Clave en cloud.cerebras.ai",
  },
  {
    id: "sambanova",
    name: "SambaNova",
    base: "https://api.sambanova.ai/v1",
    glyph: "Sn",
    color: "#0ea5e9",
    help: "Clave en cloud.sambanova.ai",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    base: "https://router.huggingface.co/v1",
    glyph: "HF",
    color: "#ffcc00",
    help: "Token en huggingface.co/settings/tokens",
  },
  {
    id: "novita",
    name: "Novita AI",
    base: "https://api.novita.ai/v3/openai",
    glyph: "Nv",
    color: "#7c3aed",
    help: "Clave en novita.ai/settings",
  },
  {
    id: "siliconflow",
    name: "SiliconFlow",
    base: "https://api.siliconflow.cn/v1",
    glyph: "SF",
    color: "#06b6d4",
    help: "Clave en siliconflow.cn/account/ak",
  },
  {
    id: "hyperbolic",
    name: "Hyperbolic",
    base: "https://api.hyperbolic.xyz/v1",
    glyph: "Hp",
    color: "#ec4899",
    help: "Clave en app.hyperbolic.xyz/settings",
  },
  {
    id: "cohere",
    name: "Cohere",
    base: "https://api.cohere.com/compatibility/v1",
    glyph: "Co",
    color: "#39d353",
    help: "Clave en dashboard.cohere.com/api-keys",
  },
  {
    id: "dashscope",
    name: "Alibaba (Qwen)",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    glyph: "Q",
    color: "#ff6a00",
    help: "Clave en dashscope.console.aliyun.com",
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    base: "https://api.moonshot.cn/v1",
    glyph: "K",
    color: "#1e3a8a",
    help: "Clave en platform.moonshot.cn",
  },
  {
    id: "minimax",
    name: "MiniMax",
    base: "https://api.minimax.chat/v1",
    glyph: "MM",
    color: "#000000",
    help: "Clave en platform.minimaxi.com",
  },
  {
    id: "custom",
    name: "Personalizado",
    base: "",
    glyph: "◆",
    color: "#9aa4b2",
    help: "Cualquier servidor compatible con OpenAI (p. ej. LM Studio: http://localhost:1234/v1)",
  },
];

const NOT_CHAT = [
  "embed",
  "whisper",
  "tts",
  "moderation",
  "transcri",
  "realtime",
  "audio",
  "rerank",
  "guard",
];
const IMAGE_WORDS = ["image", "dall-e", "imagen", "flux", "gpt-image"];
const VISION_WORDS = [
  "vision",
  "4o",
  "gpt-4.1",
  "gpt-5",
  "gemini",
  "-vl",
  "vl-",
  "llava",
  "pixtral",
  "claude",
];

const OPENAI_PRICES: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10.0],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2.0, 8.0],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4-turbo": [10.0, 30.0],
  "gpt-4": [30.0, 60.0],
  "gpt-3.5-turbo": [0.5, 1.5],
  o1: [15.0, 60.0],
  "o1-mini": [1.1, 4.4],
  "o1-preview": [15.0, 60.0],
  o3: [2.0, 8.0],
  "o3-mini": [1.1, 4.4],
  "o4-mini": [1.1, 4.4],
};

export function presetById(presetId: string): ProviderPreset {
  return PRESETS.find((item) => item.id === presetId) || PRESETS[PRESETS.length - 1];
}

export function classify(modelId: string): "code" | "image" | null {
  const low = modelId.toLowerCase();
  if (NOT_CHAT.some((w) => low.includes(w))) return null;
  if (IMAGE_WORDS.some((w) => low.includes(w))) return "image";
  return "code";
}

function isVision(modelId: string): boolean {
  const low = modelId.toLowerCase();
  return VISION_WORDS.some((w) => low.includes(w));
}

function openaiPrice(modelId: string): [number | null, number | null] {
  const low = modelId.toLowerCase();
  const keys = Object.keys(OPENAI_PRICES).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (low.includes(key)) return OPENAI_PRICES[key];
  }
  return [null, null];
}

export function isFreeModel(modelId: string): boolean {
  const text = String(modelId || "").toLowerCase();
  return (
    text.includes("free") ||
    text.includes("preview") ||
    text.includes("trial") ||
    text.includes("distill") ||
    text.includes("coder") ||
    text.endsWith("-code") ||
    text.includes("-code-") ||
    text.includes("instruct") ||
    text.includes("-small") ||
    text.includes("v0.1") ||
    text.includes("flash")
  );
}

export function records(cfg: UserConfig): CustomProviderRecord[] {
  return Array.isArray(cfg.custom_providers)
    ? cfg.custom_providers.filter((item) => Boolean(item && typeof item === "object"))
    : [];
}

export function getCustom(cfg: UserConfig, pid: string): CustomProviderRecord | null {
  return records(cfg).find((item) => item.id === pid) || null;
}

export function uniqueId(cfg: UserConfig, presetId: string): string {
  const taken = new Set([
    ...catalog.BASE_PROVIDERS.map((p) => p.id),
    ...records(cfg).map((r) => r.id),
  ]);
  let candidate = presetId;
  let num = 2;
  while (taken.has(candidate)) {
    candidate = `${presetId}-${num}`;
    num += 1;
  }
  return candidate;
}

export function providerEntry(record: CustomProviderRecord): ProviderInfo {
  return {
    id: record.id,
    name: record.name,
    sub: record.base || "",
    glyph: record.glyph || "◆",
    color: record.color || "#9aa4b2",
    custom: true,
    categories: Array.isArray(record.categories) && record.categories.length ? record.categories : ["code"],
  };
}

export async function fetchCustomModels(record: CustomProviderRecord): Promise<ModelData[]> {
  const base = String(record.base || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    throw new api.ApiError("La URL debe empezar por http:// o https://");
  }
  const lowBase = base.toLowerCase();
  if (lowBase.includes("openrouter.ai")) {
    return await catalog.fetchOpenRouterCatalog(record.id, false, false);
  }
  if (record.id.toLowerCase().includes("ollama") || lowBase.includes(":11434")) {
    return await catalog.fetchOllamaCatalog(record.id, base);
  }
  const resp = await api.requestJson<{ data?: Array<Record<string, unknown>> }>(
    `${base}/models`,
    null,
    record.key || "",
    30_000
  );
  const raw = Array.isArray(resp.data) ? resp.data : [];
  const pid = record.id;
  const name = record.name || pid;
  const models: ModelData[] = [];

  for (const item of raw) {
    const modelId = String(item.id || "").trim();
    const category = modelId ? classify(modelId) : null;
    if (!category) continue;
    const vision = isVision(modelId) && category === "code";
    const tags = category === "code" ? ["herramientas"] : ["imagen"];
    if (vision) tags.push("visión");
    const isFree = isFreeModel(modelId);
    const isOpenAI = base.toLowerCase().includes("api.openai.com");
    const [pIn, pOut] = isOpenAI ? openaiPrice(modelId) : [null, null];
    let customPaid: boolean;
    if (isOpenAI && (pIn != null || pOut != null)) {
      tags.push("de pago");
      customPaid = false;
    } else {
      customPaid = !isFree;
      if (!isFree) tags.push("de pago");
    }
    if (isFree) tags.push("gratis");
    models.push({
      provider: pid,
      uid: modelId,
      name: modelId,
      category,
      free: isFree,
      p_in: pIn,
      p_out: pOut,
      price: isFree ? 0 : null,
      unit: category === "code" ? "1M tokens" : "imagen",
      context: null,
      desc: `Modelo de ${name}. ${isFree ? "gratis" : "por consultar en cuenta"}. Revisa tu cuenta para confirmar.`,
      tags,
      extra: {
        modality: vision ? "text+image->text" : "text->text",
        custom: true,
        free_model: isFree,
        custom_paid: customPaid,
      },
    });
  }

  if (!models.length) {
    throw new api.ApiError("La API respondió, pero no encontré modelos de chat ni de imagen.");
  }
  return models;
}
