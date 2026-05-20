// API helpers — wrap fetch with shared error handling.

export interface ModelStatus {
  backend: "openai" | "ollama";
  model: string;
  openai_model: string;
  ollama_model: string;
  ollama_host: string;
  available_backends: string[];
  openai_key_set: boolean;
  ollama_reachable: boolean;
  has_usable_backend: boolean;
}

export interface MCPServer {
  name: string;
  status: "connected" | "degraded" | "disabled" | "pending";
  error: string | null;
  tools: { name: string; description: string }[];
}

export interface RunRow {
  task_id: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  idea: string | null;
  memo: string | null;
  cost_usd: number;
  model_backend: string | null;
}

export interface TimelineEvent {
  id: number;
  ts: number;
  kind: string;
  role: string | null;
  payload: Record<string, unknown>;
}

export interface MemoryGraphNode {
  id: number;
  name: string;
  type: string;
  canonical_id: string | null;
  mention_count: number;
  first_seen: number | null;
  last_seen: number | null;
}

export interface MemoryGraphLink {
  source: number;
  target: number;
  value: number;
}

export interface MemoryGraphData {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
}

export interface EntityMention {
  id: number;
  source_kind: string;
  source_id: string;
  context_snippet: string | null;
  ts: number;
}

export interface EntityDetail {
  entity: MemoryGraphNode | null;
  mentions: EntityMention[];
}

export type EventCategory =
  | "symptom"
  | "meal"
  | "sleep"
  | "exercise"
  | "supplement"
  | "medication"
  | "mood"
  | "note";

export const EVENT_CATEGORIES: EventCategory[] = [
  "symptom",
  "meal",
  "sleep",
  "exercise",
  "supplement",
  "medication",
  "mood",
  "note",
];

export interface LoggedEvent {
  id: number;
  profile_id: number | null;
  ts: number;
  day: string; // YYYY-MM-DD
  category: EventCategory;
  description: string;
  tags: string[];
  meta: Record<string, unknown>;
  created_at: number;
}

export interface CategoryCount {
  day: string;
  category: EventCategory;
  n: number;
}

export interface CheckIn {
  id: number;
  day: string;
  energy: number | null;
  sleep_hours: number | null;
  mood: number | null;
  adherence_notes: string | null;
  created_at: number;
}

export interface ProfileSynthesis {
  notes: string | null;
  synthesized_at: number | null;
  check_ins: number;
  run_memos: number;
  biomarkers: number;
}

export interface BiomarkerRow {
  name: string;
  value: string;
  unit: string | null;
  flag: string | null;
  recorded_at: number;
}

export interface MemoryGraphSources {
  check_ins: CheckIn[];
  run_memos: {
    task_id: string;
    idea: string | null;
    memo: string | null;
    started_at: number | null;
    ended_at: number | null;
    status: string | null;
  }[];
  profile: ProfileSynthesis;
  biomarkers: BiomarkerRow[];
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  authStatus: () => jsonFetch<{ required: boolean }>("/api/auth/status"),
  modelStatus: () => jsonFetch<ModelStatus>("/api/model/status"),
  setModelSettings: (body: {
    password: string;
    backend: string;
    openai_model?: string;
    ollama_model?: string;
    ollama_host?: string;
  }) =>
    jsonFetch<ModelStatus>("/api/model/settings", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  mcpServers: () =>
    jsonFetch<{ servers: MCPServer[] }>("/api/mcp/servers").then((r) => r.servers),
  reconnectMCP: (name: string, password: string) =>
    jsonFetch<{ servers: MCPServer[] }>(
      `/api/mcp/servers/${encodeURIComponent(name)}/reconnect`,
      { method: "POST", body: JSON.stringify({ password }) },
    ).then((r) => r.servers),

  runs: (limit = 20) =>
    jsonFetch<{ runs: RunRow[] }>(`/api/runs?limit=${limit}`).then((r) => r.runs),
  run: (taskId: string) => jsonFetch<RunRow>(`/api/runs/${taskId}`),
  timeline: (taskId: string) =>
    jsonFetch<{ task_id: string; events: TimelineEvent[] }>(
      `/api/runs/${taskId}/timeline`,
    ).then((r) => r.events),

  profile: () => jsonFetch<Record<string, unknown>>("/api/profile"),
  saveProfile: (body: Record<string, unknown> & { password: string }) =>
    jsonFetch("/api/profile", { method: "POST", body: JSON.stringify(body) }),
  profileSynthesis: () =>
    jsonFetch<ProfileSynthesis>("/api/profile/synthesis"),
  synthesizeProfile: (body: { password: string }) =>
    jsonFetch<ProfileSynthesis>("/api/profile/synthesize", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  recentBiomarkers: (limit = 60) =>
    jsonFetch<{ biomarkers: BiomarkerRow[] }>(
      `/api/biomarkers/recent?limit=${limit}`,
    ).then((r) => r.biomarkers),

  checkIns: (limit = 30) =>
    jsonFetch<{ check_ins: CheckIn[] }>(`/api/check_ins?limit=${limit}`).then(
      (r) => r.check_ins,
    ),
  addCheckIn: (body: Partial<CheckIn> & { password: string }) =>
    jsonFetch<CheckIn>("/api/check_ins", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  prompts: () =>
    jsonFetch<Record<string, string>>("/api/prompts"),

  // v3 — memory graph
  memoryGraph: (minMentions = 1) =>
    jsonFetch<MemoryGraphData>(`/api/memory-graph?min_mentions=${minMentions}`),
  entityMentions: (id: number, limit = 50) =>
    jsonFetch<EntityDetail>(
      `/api/memory-graph/entities/${id}/mentions?limit=${limit}`,
    ),
  reindexMemoryGraph: (body: { password: string; clear?: boolean }) =>
    jsonFetch<{ ok: boolean; indexed: Record<string, number> }>(
      "/api/memory-graph/reindex",
      { method: "POST", body: JSON.stringify(body) },
    ),
  memoryGraphSources: () =>
    jsonFetch<MemoryGraphSources>("/api/memory-graph/sources"),

  // v3 — events / calendar
  events: (params: {
    since?: string;
    until?: string;
    category?: EventCategory;
    limit?: number;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.since) qs.set("since", params.since);
    if (params.until) qs.set("until", params.until);
    if (params.category) qs.set("category", params.category);
    if (params.limit) qs.set("limit", String(params.limit));
    return jsonFetch<{ events: LoggedEvent[] }>(
      `/api/events${qs.toString() ? `?${qs}` : ""}`,
    ).then((r) => r.events);
  },
  logEvent: (body: {
    password: string;
    category: EventCategory;
    description: string;
    day?: string;
    tags?: string[];
    meta?: Record<string, unknown>;
  }) =>
    jsonFetch<LoggedEvent>("/api/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteEvent: (id: number, password: string) =>
    jsonFetch<{ ok: true }>(`/api/events/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ password }),
    }),
  categoryCounts: (since: string, until: string) =>
    jsonFetch<{ counts: CategoryCount[] }>(
      `/api/events/category-counts?since=${since}&until=${until}`,
    ).then((r) => r.counts),
};
