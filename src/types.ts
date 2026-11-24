export const APP_VERSION = "1.12.0";

export type ModelGroup = "code" | "reasoning" | "vision" | "chat" | "image" | "video";

export interface ModelGroupInfo {
  id: ModelGroup;
  label: string;
  short_label: string;
  icon: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  sub: string;
  glyph: string;
  color: string;
  categories: string[];
  custom?: boolean;
}

export interface CustomProviderRecord {
  id: string;
  name: string;
  base: string;
  key: string;
  glyph: string;
  color: string;
  categories: string[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  base: string;
  glyph: string;
  color: string;
  help: string;
}

export interface ModelData {
  provider: string;
  uid: string;
  name: string;
  category: "code" | "image" | "video";
  free: boolean;
  p_in: number | null;
  p_out: number | null;
  price: number | null;
  unit: string;
  context: number | null;
  desc: string;
  tags: string[];
  extra: Record<string, unknown>;
}

export interface ModelPayload extends ModelData {
  group: ModelGroup;
  group_label: string;
  price_text: string;
  price_detail: string;
  context_text: string;
  info_text: string;
  effective_price: number | null;
  provider_name: string;
  provider_color: string;
  provider_glyph: string;
  relevance_score: number;
  cached_at?: number | null;
}

export interface UsageBucket {
  requests: number;
  prompt: number;
  completion: number;
  cost: number;
  images: number;
  videos: number;
}

export interface UsageStats extends UsageBucket {
  date?: string;
  today: UsageBucket;
}

export interface UserConfig {
  openrouter_api_key: string;
  workdir: string;
  projects_root: string;
  output_root: string;
  auto_refresh: boolean;
  last_provider: string;
  last_category: string;
  last_models: Record<string, string>;
  custom_providers: CustomProviderRecord[];
  usage: Record<string, UsageStats>;
  favorite_models: string[];
  [key: string]: unknown;
}

export interface UserRecord {
  id: string;
  name: string;
  role: "admin" | "user";
  salt: string;
  hash: string;
  iterations: number;
  created: number;
  data_dir?: string;
}

export interface PublicUser {
  id: string;
  name: string;
  role: "admin" | "user";
  created: number;
  desktop: boolean;
  data_dir?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string | Array<Record<string, unknown>>;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
  name?: string;
  images?: unknown[];
}

export interface ConversationRecord {
  id: string;
  title: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  updated: number;
}

export interface ConversationStore {
  items: ConversationRecord[];
  current: ConversationRecord | null;
}

export interface ContextInfo {
  tokens: number;
  sent_tokens: number;
  limit: number;
  turns: number;
  messages: number;
  sent: number;
  dropped: number;
  truncated: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  kinds: string[];
  count: number;
  mtime: number;
  root: boolean;
  outside?: boolean;
  active: boolean;
}
