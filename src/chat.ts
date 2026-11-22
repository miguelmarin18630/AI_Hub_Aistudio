import type { ChatMessage, ContextInfo } from "./types.ts";

export const DEFAULT_CONTEXT = 32_768;
export const OLLAMA_CONTEXT = 8_192;
export const RESERVE_TOKENS = 1_024;
export const CLI_CONTEXT = 12_000;

export const DEFAULT_SYSTEM_PROMPT =
  "Eres AI Hub, un asistente de IA útil, directo y honesto. " +
  "Responde en el idioma del usuario (por defecto, en español). " +
  "Ten en cuenta los mensajes anteriores de la conversación: mantén el hilo, " +
  "no vuelvas a preguntar lo que el usuario ya explicó y usa el contexto disponible. " +
  "Si no sabes algo o necesitas un dato que no tienes, dilo en lugar de inventarlo. " +
  "Cuando escribas código, usa bloques de código y explica solo lo necesario.";

export const EXPLAIN_STEPS: Array<[string, string]> = [
  [
    "1. Escribes una consulta",
    "La app la añade al historial como un mensaje de usuario. El historial es la " +
      "memoria de la conversación: sin él, cada pregunta empezaría de cero.",
  ],
  [
    "2. Se construye el contexto",
    "Antes de llamar al modelo se envía: las instrucciones del sistema (cómo debe " +
      "responder), los turnos anteriores y tu mensaje nuevo. Así la segunda pregunta " +
      "puede apoyarse en la primera respuesta.",
  ],
  [
    "3. Se respeta la ventana del modelo",
    "Cada modelo admite un máximo de tokens. Si la conversación crece demasiado, " +
      "la app recorta los turnos más antiguos y conserva los recientes. El indicador " +
      "«Contexto» de la cabecera muestra cuánto se está usando.",
  ],
  [
    "4. El modelo responde",
    "La respuesta llega en streaming y se guarda como mensaje del asistente. En los " +
      "modelos con herramientas, también se guardan las lecturas y escrituras de " +
      "archivos para que el siguiente turno sepa qué se hizo.",
  ],
  [
    "5. La conversación continúa",
    "Cambiar de modelo o de proveedor no borra el hilo: el contexto se envía al " +
      "modelo nuevo. «Nuevo chat» sí empieza una conversación limpia. Al cerrar la " +
      "app, el historial queda en conversations.json y se recupera al abrirla.",
  ],
];

export function explainText(): string {
  return EXPLAIN_STEPS.map(([title, body]) => `${title}\n${body}`).join("\n\n");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string") {
        parts.push((item as Record<string, unknown>).text as string);
      }
    }
    return parts.join("\n");
  }
  return value == null ? "" : String(value);
}

export function estimateTokens(value: unknown): number {
  if (Array.isArray(value)) {
    const tokens = estimateTokens(asText(value));
    const images = value.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        ["image_url", "image"].includes(String((item as Record<string, unknown>).type || ""))
    ).length;
    return tokens + images * 800;
  }
  const text = asText(value);
  if (!text) return 0;
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

export function messageTokens(message: ChatMessage): number {
  let tokens = 4 + estimateTokens(message.content);
  if (Array.isArray(message.images)) {
    tokens += message.images.length * 800;
  }
  return tokens;
}

export function historyTokens(history: ChatMessage[]): number {
  return history.reduce((sum, item) => sum + messageTokens(item), 0);
}

export function turnCount(history: ChatMessage[]): number {
  return history.filter((item) => item.role === "user").length;
}

function normalized(history: ChatMessage[]): ChatMessage[] {
  const clean: ChatMessage[] = [];
  for (const item of history || []) {
    if (!item || typeof item !== "object") continue;
    if (!["user", "assistant", "tool", "system"].includes(item.role)) continue;
    clean.push({ ...item });
  }
  return clean;
}

function truncateLastUser(messages: ChatMessage[], budget: number): boolean {
  if (!messages.length) return false;
  const last = messages[messages.length - 1];
  if (last.role !== "user" || typeof last.content !== "string") return false;
  const excess = historyTokens(messages) - budget;
  if (excess <= 0) return false;
  const keep = Math.max(500, last.content.length - excess * 4);
  if (keep >= last.content.length) return false;
  last.content = last.content.slice(0, keep) + "\n\n[… recortado por espacio de contexto]";
  return true;
}

export function buildMessages(
  history: ChatMessage[],
  opts: {
    limit?: number;
    systemPrompt?: string;
    reserve?: number;
  } = {}
): { messages: ChatMessage[]; info: ContextInfo } {
  const clean = normalized(history);
  const limit = Math.max(1024, Math.floor(opts.limit || DEFAULT_CONTEXT));
  const systemPrompt = opts.systemPrompt !== undefined ? opts.systemPrompt : DEFAULT_SYSTEM_PROMPT;
  const reserve = opts.reserve !== undefined ? opts.reserve : RESERVE_TOKENS;
  const system: ChatMessage | null = systemPrompt ? { role: "system", content: systemPrompt } : null;
  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) : 0;
  const budget = Math.max(512, limit - Math.max(0, reserve) - systemTokens);

  const totalTokens = historyTokens(clean);
  const turns = turnCount(clean);

  const boundaries: number[] = [];
  clean.forEach((item, index) => {
    if (item.role === "user") boundaries.push(index);
  });

  let selected: ChatMessage[] = [];
  if (boundaries.length) {
    for (const start of boundaries) {
      const candidate = clean.slice(start);
      if (historyTokens(candidate) <= budget) {
        selected = candidate;
        break;
      }
    }
    if (!selected.length) {
      selected = clean.slice(boundaries[boundaries.length - 1]);
    }
  }

  const truncated = truncateLastUser(selected, budget);
  const sentTokens = historyTokens(selected);
  const messages = system ? [system, ...selected] : selected;

  return {
    messages,
    info: {
      tokens: totalTokens,
      sent_tokens: sentTokens,
      limit,
      turns,
      messages: clean.length,
      sent: selected.length,
      dropped: Math.max(0, clean.length - selected.length),
      truncated,
    },
  };
}

export function fmtTokens(value: number): string {
  const n = Math.max(0, Math.floor(Number(value || 0)));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`.replace(".", ",");
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`.replace(".", ",");
  return String(n);
}

export function contextNote(info: ContextInfo): string {
  if (info.dropped <= 0 && !info.truncated) return "";
  const bits = [`Contexto: se envían los últimos ${info.sent} mensajes`];
  if (info.truncated) bits.push("y se recortó la consulta");
  return `${bits.join(" · ")} (~${fmtTokens(info.sent_tokens)} de ${fmtTokens(info.limit)} tokens).`;
}
