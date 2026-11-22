import * as config from "./config.ts";
import type { UsageBucket, UsageStats } from "./types.ts";

function keyOf(provider: string, uid: string): string {
  return `${provider}:${uid}`;
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function blank(): UsageBucket {
  return { requests: 0, prompt: 0, completion: 0, cost: 0, images: 0, videos: 0 };
}

function addBucket(
  target: UsageBucket,
  delta: {
    requests: number;
    prompt: number;
    completion: number;
    cost: number;
    images: number;
    videos: number;
  }
): void {
  target.requests = Math.floor(Number(target.requests || 0)) + delta.requests;
  target.prompt = Math.floor(Number(target.prompt || 0)) + delta.prompt;
  target.completion = Math.floor(Number(target.completion || 0)) + delta.completion;
  target.cost = Number((Number(target.cost || 0) + delta.cost).toFixed(6));
  target.images = Math.floor(Number(target.images || 0)) + delta.images;
  target.videos = Math.floor(Number(target.videos || 0)) + delta.videos;
}

function rotate(raw?: Partial<UsageStats>): UsageStats {
  const stats: UsageStats = {
    ...blank(),
    ...(raw || {}),
    today: blank(),
  };
  const today = todayIso();
  if (stats.date !== today) {
    stats.date = today;
    stats.today = blank();
  } else {
    stats.today = { ...blank(), ...(raw?.today || {}) };
  }
  return stats;
}

export function getUsage(provider: string, uid: string): UsageStats {
  const usageMap = config.loadConfig().usage || {};
  return rotate(usageMap[keyOf(provider, uid)]);
}

export function recordUsage(
  provider: string,
  uid: string,
  delta: {
    prompt?: number;
    completion?: number;
    cost?: number;
    images?: number;
    videos?: number;
  }
): void {
  const prompt = Math.floor(Number(delta.prompt || 0));
  const completion = Math.floor(Number(delta.completion || 0));
  const images = Math.floor(Number(delta.images || 0));
  const videos = Math.floor(Number(delta.videos || 0));
  const cost = Number(delta.cost || 0);
  const requests = prompt || completion || cost || images || videos ? 1 : 0;

  const data = config.loadConfig();
  const usageMap = { ...(data.usage || {}) };
  const key = keyOf(provider, uid);
  const stats = rotate(usageMap[key]);

  if (!requests && !stats.requests) return;

  const add = { requests, prompt, completion, cost, images, videos };
  addBucket(stats, add);
  addBucket(stats.today, add);
  usageMap[key] = stats;
  config.updateConfig({ usage: usageMap });
}

function fmtInt(n: number): string {
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function summary(stats?: UsageBucket): string {
  if (!stats || !stats.requests) return "";
  const bits: string[] = [];
  const tIn = Math.floor(Number(stats.prompt || 0));
  const tOut = Math.floor(Number(stats.completion || 0));
  if (tIn || tOut) {
    bits.push(`${fmtInt(tIn)}↑ ${fmtInt(tOut)}↓ tokens`);
  }
  if (stats.images) bits.push(`${stats.images} imagen(es)`);
  if (stats.videos) bits.push(`${stats.videos} vídeo(s)`);
  if (stats.cost) bits.push(`$${Number(stats.cost).toFixed(4)}`);
  const body = bits.join(" · ");
  return `${stats.requests} uso(s)` + (body ? ` · ${body}` : "");
}

export function describeUsage(stats?: UsageStats): string {
  const total = summary(stats);
  if (!total) return "Sin uso desde esta app todavía.";
  const today = summary(stats?.today);
  if (!today) return `Hoy: sin uso · Total: ${total}`;
  return `Hoy: ${today} · Total: ${total}`;
}
