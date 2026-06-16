export interface AgentInfo {
  name: string;
  kind: string;
  description: string;
  tools: string[];
  permissionMode?: string;
  skills?: string[];
  guarded: boolean;
  cwd?: string;
  members?: string[];
}

export interface StateInfo {
  uptimeMs: number;
  voice: boolean;
  agents: AgentInfo[];
  playbooks: Array<{ name: string; description: string }>;
  bindings: Array<{ chatKey: string; agents: string[]; mentionOnly: boolean }>;
}

export interface StageInfo {
  stage_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

export interface JobInfo {
  id: string;
  slug: string;
  title: string;
  playbook: string;
  request: string;
  project_dir: string | null;
  channel: string;
  chat_id: string;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  stages: StageInfo[];
}

export interface JobDetail extends JobInfo {
  artifacts: Array<{ file: string; content: string }>;
  vaultDir: string;
}

export interface StoredEvent {
  id: number;
  ts: string;
  event: Record<string, unknown> & { type: string };
}

export interface ActionInfo {
  id: string;
  type: string;
  payload: string;
  preview: string;
  status: string;
  origin_channel: string;
  origin_chat_id: string;
  trust_state: string;
  verdict_by: string | null;
  reject_reason: string | null;
  result: string | null;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
}

export interface TrustInfo {
  actionType: string;
  state: "supervised" | "graduating" | "autonomous";
  approvals: number;
  rejections: number;
  streak: number;
  firstSeen: string;
  lastRejection: string | null;
  graduatedAt: string | null;
}

export interface PermissionInfo {
  role: string;
  description: string;
  permissionMode: string;
  toolCheckFallback: string;
  skills: string[];
  tools: { name: string; source: "default" | "granted" | "revoked" }[];
  revoked: { name: string; source: "revoked" }[];
  denials: { tool: string; count: number; lastTs: string }[];
}

export function getToken(): string {
  return localStorage.getItem("aios_token") ?? "";
}

export function setToken(t: string): void {
  localStorage.setItem("aios_token", t);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  state: () => request<StateInfo>("/api/state"),
  jobs: () => request<JobInfo[]>("/api/jobs"),
  job: (id: string) => request<JobDetail>(`/api/jobs/${id}`),
  costs: () => request<{ byAgent: Record<string, number>; byDay: Record<string, number> }>("/api/costs"),
  chat: (target: string, text: string) =>
    request<{ reply: string | null }>("/api/chat", { method: "POST", body: JSON.stringify({ target, text }) }),
  playbooks: () => request<Array<{ file: string; yaml: string }>>("/api/playbooks"),
  savePlaybook: (file: string, yaml: string) =>
    request<{ ok: boolean }>(`/api/playbooks/${file}`, { method: "PUT", body: JSON.stringify({ yaml }) }),
  config: () => request<Array<{ key: string; secret: boolean; set: boolean; value: string }>>("/api/config"),
  saveConfig: (key: string, value: string) =>
    request<{ ok: boolean; note: string }>("/api/config", { method: "PUT", body: JSON.stringify({ key, value }) }),
  restart: () => request<{ ok: boolean }>("/api/restart", { method: "POST" }),
  actions: (status?: string) =>
    request<ActionInfo[]>(`/api/actions${status ? `?status=${status}` : ""}`),
  resolveAction: (id: string, verdict: "approve" | "reject", reason?: string) =>
    request<ActionInfo>(`/api/actions/${id}/resolve`, { method: "POST", body: JSON.stringify({ verdict, reason }) }),
  trust: () => request<TrustInfo[]>("/api/trust"),
  demoteTrust: (type: string) =>
    request<{ ok: boolean }>(`/api/trust/${type}/demote`, { method: "POST" }),
  permissions: () => request<PermissionInfo[]>("/api/permissions"),
  proposePermission: (role: string, tool: string, action: "grant" | "revoke") =>
    request<{ id: string; status: string }>("/api/permissions/propose", {
      method: "POST",
      body: JSON.stringify({ role, tool, action }),
    }),
  voiceChat: async (target: string, blob: Blob) => {
    const res = await fetch(`/api/voice?target=${encodeURIComponent(target)}`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/webm",
        ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      },
      body: blob,
    });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json() as Promise<{ transcript: string; reply: string; audio: string | null }>;
  },
};
