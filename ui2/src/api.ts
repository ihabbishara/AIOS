// Wire types live in src/web/dto.ts — one contract for server builders and this client.
export type {
  AgentInfo, StateInfo, StoredEvent, ActionInfo, TrustInfo,
  OrgAgentCard, OrgDepartmentView, AgentProfileInfo, AgentActivityInfo, PermissionInfo,
  PackRoleView, PackPlaybookView, PackJobView, PackWorkspaceView, PackView,
  GoalNodeView, GoalView, GoalDetail, MailView, UserThreadView, BudgetInfo,
  AttentionItem, HealthInfo,
  ScheduleView, RoutineView, AnchorView, ScheduleReminderView, Recurrence,
  SkillView, WebAttachment,
} from "../../src/web/dto.js";
import type {
  StateInfo, StoredEvent, ActionInfo, TrustInfo,
  OrgDepartmentView, AgentProfileInfo, AgentActivityInfo, PermissionInfo, PackView,
  GoalView, GoalDetail, MailView, UserThreadView, BudgetInfo,
  AttentionItem, HealthInfo,
  ScheduleView, Recurrence, SkillView, WebAttachment,
} from "../../src/web/dto.js";

export function getToken(): string {
  return localStorage.getItem("aios_token") ?? "";
}

export function setToken(t: string): void {
  localStorage.setItem("aios_token", t);
}

/** Thrown on a 401 so the token gate keys off a type, not a magic string that a rename could
 *  silently break. */
export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); this.name = "UnauthorizedError"; }
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
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  state: () => request<StateInfo>("/api/state"),
  attention: () => request<AttentionItem[]>("/api/attention"),
  health: () => request<HealthInfo>("/api/health"),
  org: () => request<OrgDepartmentView[]>("/api/org"),
  agent: (name: string) => request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}`),
  hireAgent: (body: { name: string; department: string; kind: string; title: string; charter: string; persona: string; prompt: string; capabilities: string[] }) =>
    request<AgentProfileInfo>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  retireAgent: (name: string) =>
    request<{ ok: true; archived: string }>(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
  agentActivity: (name: string) =>
    request<AgentActivityInfo>(`/api/agents/${encodeURIComponent(name)}/activity`),
  patchAgentManifest: (name: string, field: string, value: string | number) =>
    request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}/manifest`, {
      method: "PATCH", body: JSON.stringify({ field, value }),
    }),
  goals: () => request<GoalView[]>("/api/goals"),
  goal: (idOrSlug: string) => request<GoalDetail>(`/api/goals/${encodeURIComponent(idOrSlug)}`),
  goalAction: (idOrSlug: string, verb: "pause" | "resume" | "abandon") =>
    request<{ message: string }>(`/api/goals/${encodeURIComponent(idOrSlug)}/${verb}`, { method: "POST" }),
  resolveReview: (goalId: string, node: string, verdict: "accept" | "retry" | "abandon", guidance?: string) =>
    request<{ message: string }>(
      `/api/goals/${encodeURIComponent(goalId)}/review/${encodeURIComponent(node)}`,
      { method: "POST", body: JSON.stringify({ verdict, ...(guidance?.trim() ? { guidance } : {}) }) },
    ),
  mail: (agent?: string, limit = 50) =>
    request<MailView[]>(`/api/mail?${agent ? `agent=${encodeURIComponent(agent)}&` : ""}limit=${limit}`),
  mailUnread: () => request<{ total: number; byAgent: Record<string, number>; pendingUser: number; userInbox: number }>("/api/mail/unread"),
  mailMine: () => request<{ threads: UserThreadView[] }>("/api/mail/mine"),
  mailThreadView: (id: string) => request<MailView[]>(`/api/mail/thread/${encodeURIComponent(id)}`),
  composeMail: (args: { to: string; body: string; threadId?: string; inReplyTo?: string }) =>
    request<{ ok: true; id: string } | { ok: false; refusal: string }>("/api/mail/compose", {
      method: "POST", body: JSON.stringify(args),
    }),
  markMailRead: (id: string) =>
    request<{ ok: boolean }>(`/api/mail/${encodeURIComponent(id)}/read`, { method: "POST" }),
  answerMail: (id: string, text: string) =>
    request<{ resumed: boolean }>(`/api/mail/${encodeURIComponent(id)}/answer`, {
      method: "POST", body: JSON.stringify({ text }),
    }),
  budget: () => request<BudgetInfo>("/api/budget"),
  events: (since = 0) => request<StoredEvent[]>(`/api/events?since=${since}`),
  costs: () => request<{ byAgent: Record<string, number>; byDay: Record<string, number> }>("/api/costs"),
  chat: (target: string, text: string) =>
    request<{ reply: string | null; attachments: WebAttachment[] }>("/api/chat", { method: "POST", body: JSON.stringify({ target, text }) }),
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
  schedule: () => request<ScheduleView>("/api/schedule"),
  addRoutine: (r: { name: string; prompt: string; recurrence: Recurrence }) =>
    request<{ id: number }>("/api/routines", { method: "POST", body: JSON.stringify(r) }),
  updateRoutine: (id: number, patch: { name?: string; prompt?: string; recurrence?: Recurrence; enabled?: boolean }) =>
    request<{ ok: true }>(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoutine: (id: number) => request<{ ok: true }>(`/api/routines/${id}`, { method: "DELETE" }),
  runRoutine: (id: number) => request<{ ok: true }>(`/api/routines/${id}/run`, { method: "POST" }),
  setAnchor: (name: string, hhmm: string) =>
    request<{ ok: true }>(`/api/anchors/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ hhmm }) }),
  cancelReminder: (id: number) => request<{ ok: true }>(`/api/reminders/${id}`, { method: "DELETE" }),
  skills: () => request<SkillView[]>("/api/skills"),
  skillMd: (name: string) => request<{ md: string }>(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, md: string) =>
    request<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ md }) }),
  deleteSkill: (name: string, force = false) =>
    request<{ ok: true }>(`/api/skills/${encodeURIComponent(name)}${force ? "?force=1" : ""}`, { method: "DELETE" }),
  fetchSkill: (url: string) =>
    request<{ md: string }>("/api/skills/fetch", { method: "POST", body: JSON.stringify({ url }) }),
  setAgentSkills: (agent: string, skills: string[]) =>
    request<{ ok: true }>(`/api/agents/${encodeURIComponent(agent)}/skills`, { method: "PATCH", body: JSON.stringify({ skills }) }),
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
