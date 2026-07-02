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

export interface OrgAgentCard {
  name: string;
  title: string;
  charter: string;
  visibility: "shared" | "private";
  guarded: boolean;
  status: "idle" | "working" | "waiting";
  currentTask: string | null;
  costTodayUsd: number;
}

export interface OrgDepartmentView {
  department: string;
  mission: string;
  lead: string | null;
  memoDomain: string;
  sandbox: boolean;
  actions: string[];
  agents: OrgAgentCard[];
}

export interface AgentProfileInfo {
  name: string;
  title: string;
  department: string;
  mission: string;
  charter: string;
  persona: string;
  aliases: string[];
  visibility: "shared" | "private";
  permissionMode: string;
  model: string | null;
  skills: string[];
  guarded: boolean;
  maxTurns: number;
  tools: Array<{ name: string; source: "default" | "granted" }>;
  revoked: Array<{ name: string; source: "revoked" }>;
  trust: TrustInfo[];
  recentRuns: Array<{ ts: string; context: string; ok: boolean; costUsd: number | null }>;
  handoffs: Array<{ ts: string; reason: string; channel: string; chatId: string }>;
  costByDay: Record<string, number>;
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
  knownTools: string[];
}

export interface PackRoleView { name: string; description: string; privateOnly: boolean; advisoryInDirect: boolean; permissionMode: string; allowedTools: string[]; }
export interface PackPlaybookView { name: string; description: string; needsProjectDir: boolean; stages: Array<{ id: string; type: string; role: string }>; }
export interface PackJobView { id: string; title: string; playbook: string; status: string; created_at: string; projectDir: string | null; }
export interface PackWorkspaceView { taskDir: string; exists: boolean; jobId: string; title: string; status: string; }
export interface PackView {
  pillar: string; persona: string; memoDomain: string; vaultSection: string; sandbox: boolean; enabled: boolean;
  toolServer?: string; tools: string[]; actions: string[];
  roles: PackRoleView[]; playbooks: PackPlaybookView[]; recentJobs: PackJobView[]; workspaces: PackWorkspaceView[]; memoCount: number;
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
  org: () => request<OrgDepartmentView[]>("/api/org"),
  agent: (name: string) => request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}`),
  events: (since = 0) => request<StoredEvent[]>(`/api/events?since=${since}`),
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
  packs: () => request<PackView[]>("/api/packs"),
  runPack: (pillar: string, playbook: string, projectDir?: string) =>
    request<{ id: string }>(`/api/packs/${pillar}/run`, { method: "POST", body: JSON.stringify({ playbook, project_dir: projectDir }) }),
  setPackEnabled: (pillar: string, enabled: boolean) =>
    request<{ ok: boolean; restarting: boolean }>(`/api/packs/${pillar}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) }),
  packFiles: (pillar: string) => request<Array<{ file: string; yaml: string }>>(`/api/packs/${pillar}/files`),
  savePackFile: (pillar: string, file: string, yaml: string) =>
    request<{ ok: boolean; reloaded: boolean }>(`/api/packs/${pillar}/files/${file}`, { method: "PUT", body: JSON.stringify({ yaml }) }),
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
