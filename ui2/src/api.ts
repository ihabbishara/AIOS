// Wire types live in src/web/dto.ts — one contract for server builders and this client.
export type {
  AgentInfo, StateInfo, StoredEvent, ActionInfo, TrustInfo,
  OrgAgentCard, OrgDepartmentView, AgentProfileInfo, AgentActivityInfo, PermissionInfo,
  PackRoleView, PackPlaybookView, PackJobView, PackWorkspaceView, PackView,
  GoalNodeView, GoalView, GoalDetail, FirstJobStatus, MailView, UserThreadView, BudgetInfo,
  AttentionItem, HealthInfo,
  ScheduleView, RoutineView, AnchorView, ScheduleReminderView, Recurrence,
  SkillView, WebAttachment, LibraryNode,
  WikiView, WikiPageView, WikiSectionView, LibrarySearchHit,
  ShelfView, ShelfWork, ShelfDoc, ShelfFile,
} from "../../src/web/dto.js";
import type {
  StateInfo, StoredEvent, ActionInfo, TrustInfo,
  OrgDepartmentView, AgentProfileInfo, AgentActivityInfo, PermissionInfo, PackView,
  GoalView, GoalDetail, FirstJobStatus, MailView, UserThreadView, BudgetInfo,
  AttentionItem, HealthInfo,
  ScheduleView, Recurrence, SkillView, WebAttachment, LibraryNode,
  WikiView, LibrarySearchHit, ShelfView,
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

/** GET one workspace file with the bearer header. Not `request`: the 200 body is the file's own
 *  bytes rather than JSON, while a refusal IS JSON — so the not-ok branch has to be handled here
 *  or a "not a file" error would be rendered to the reader as the document's content. */
async function libraryFile(path: string): Promise<Response> {
  const res = await fetch(`/api/library/file?path=${encodeURIComponent(path)}`, {
    headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res;
}

/** The org the wizard is proposing. Nothing has been written when this is on screen. */
export interface OrgProposalView {
  source: { kind: "template"; template: string } | { kind: "interview" };
  departments: Array<{ department: string; mission: string; lead?: string }>;
  agents: Array<{
    name: string; department: string; kind: string; title: string;
    charter: string; persona: string; prompt: string; capabilities: string[]; skills: string[];
  }>;
  firstJob: string;
}

/** What the architect proposes ADDING to an org that already runs. Same shape the wizard's
 *  proposal has, minus the guarantees that only hold on day one: `departments` may be empty (most
 *  growth is a new agent in a department that exists), and no agent is ever a coordinator. */
export interface OrgGrowthProposal {
  departments: Array<{
    department: string; mission: string; memoDomain: string;
    capabilities: string[]; playbooks: string[];
  }>;
  agents: Array<{
    name: string; department: string; kind: string; title: string;
    charter: string; persona: string; prompt: string; capabilities: string[]; skills: string[];
  }>;
  firstJob: string;
}

/** What an advance answers with. Only the last one — first-job → done — carries anything past
 *  the step, and it is the only chance to read it: by the time the browser could ask again, the
 *  setup server has handed the port to mission control and every route is behind the token gate.
 *  `workspace` is already resolved to a single folder — the daemon's vault root, not a pair. */
export interface ConnectStatus {
  telegram: { connected: boolean; botUsername?: string; allowedUserIds?: string; primaryChat?: string };
  slack: { connected: boolean; team?: string; botUser?: string };
  image: { connected: boolean; model: string };
}
export interface CapturedChat {
  chatId: string; chatType: string; from: string; fromId: string; text: string;
}

export interface AdvanceResult {
  step: string;
  uiToken?: string;
  departments?: string[];
  agents?: string[];
  workspace?: string;
}

export const api = {
  state: () => request<StateInfo>("/api/state"),
  onboardingAdvance: (from: string) =>
    request<AdvanceResult>("/api/onboarding/advance", { method: "POST", body: JSON.stringify({ from }) }),
  onboardingBack: (to: string) =>
    request<{ step: string }>("/api/onboarding/back", { method: "POST", body: JSON.stringify({ to }) }),
  /** Not `request`: the auth 409 carries two different bodies and only one of them is an error.
   *  `{ step }` means the wizard already moved past auth (double submit, reload mid-verify) —
   *  that step is where the UI belongs. `{ error }` means a verification is still in flight.
   *  `request` throws on any non-2xx and keeps only `error`, so it cannot tell them apart. */
  onboardingAuth: async (token: string): Promise<{ step: string }> => {
    const res = await fetch("/api/onboarding/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body = await res.json().catch(() => ({})) as { step?: string; error?: string };
    if (body.step) return { step: body.step };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  },
  onboardingWorkspace: (choice: { mode: "builtin" | "custom"; path?: string; subdir?: string }) =>
    request<{ step: string; warning?: string }>("/api/onboarding/workspace", {
      method: "POST", body: JSON.stringify(choice),
    }),
  onboardingTemplates: () =>
    request<{ templates: Array<{ name: string; title: string; summary: string }> }>("/api/onboarding/templates"),
  onboardingPickTemplate: (name: string) =>
    request<{ step: string }>("/api/onboarding/template", { method: "POST", body: JSON.stringify({ name }) }),
  connectStatus: () => request<ConnectStatus>("/api/onboarding/connect"),
  connectTelegram: (token: string, allowedUserIds?: string) =>
    request<ConnectStatus>("/api/onboarding/connect/telegram", {
      method: "POST", body: JSON.stringify({ token, ...(allowedUserIds ? { allowedUserIds } : {}) }),
    }),
  telegramCapture: () =>
    request<{ captured: CapturedChat | null }>("/api/onboarding/connect/telegram/capture", {
      method: "POST", body: JSON.stringify({}),
    }),
  telegramPrimary: (chatId: string, userId?: string) =>
    request<ConnectStatus>("/api/onboarding/connect/telegram/primary", {
      method: "POST", body: JSON.stringify({ chatId, ...(userId ? { userId } : {}) }),
    }),
  connectSlack: (botToken: string, appToken: string) =>
    request<ConnectStatus>("/api/onboarding/connect/slack", {
      method: "POST", body: JSON.stringify({ botToken, appToken }),
    }),
  connectImage: (apiKey: string, model?: string) =>
    request<ConnectStatus>("/api/onboarding/connect/image", {
      method: "POST", body: JSON.stringify({ apiKey, ...(model ? { model } : {}) }),
    }),
  onboardingProposal: () => request<{ proposal: OrgProposalView }>("/api/onboarding/proposal"),
  interviewTurns: () =>
    request<{ turns: Array<{ role: "user" | "architect"; text: string }> }>("/api/onboarding/interview"),
  interviewSay: (message: string) =>
    request<{ done?: boolean; question?: string; step?: string }>("/api/onboarding/interview", {
      method: "POST", body: JSON.stringify({ message }),
    }),
  interviewRestart: () =>
    request<{ turns: [] }>("/api/onboarding/interview/restart", { method: "POST", body: JSON.stringify({}) }),
  patchProposal: (patch: Record<string, unknown>) =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/proposal", {
      method: "PATCH", body: JSON.stringify(patch),
    }),
  redraftAgent: (agent: string, note: string) =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/redraft", {
      method: "POST", body: JSON.stringify({ agent, note }),
    }),
  regenerate: () =>
    request<{ proposal: OrgProposalView }>("/api/onboarding/regenerate", {
      method: "POST", body: JSON.stringify({}),
    }),
  capabilityCatalog: () => request<{ capabilities: string[]; skills: string[] }>("/api/onboarding/catalog"),
  /** Not `request`: a rejected provision carries per-card `errors` that request() would discard,
   *  since it reads only `error` off a failed response. Same reason onboardingAuth bypasses it. */
  onboardingProvision: async (): Promise<
    | { ok: true; step: string; departments: string[]; agents: string[] }
    | { ok: false; errors: Array<{ scope: string; name?: string; error: string }>; message: string }
  > => {
    const res = await fetch("/api/onboarding/provision", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const body = (await res.json().catch(() => ({}))) as {
      step?: string; departments?: string[]; agents?: string[];
      error?: string; errors?: Array<{ scope: string; name?: string; error: string }>;
    };
    if (res.ok) {
      return { ok: true, step: body.step!, departments: body.departments ?? [], agents: body.agents ?? [] };
    }
    return { ok: false, errors: body.errors ?? [], message: body.error ?? `HTTP ${res.status}` };
  },
  firstJobStatus: () => request<FirstJobStatus>("/api/onboarding/first-job"),
  /** `request_`, not `request`: the module-level helper of that name is what sends it. */
  runFirstJob: (request_: string) =>
    request<{ status: string }>("/api/onboarding/first-job", {
      method: "POST", body: JSON.stringify({ request: request_ }),
    }),
  /** Retry after a failed hot boot. A refused boot answers 500/409, which `request` turns into
   *  a throw — so the resolved `{ booted: false }` shape is unreachable in practice and callers
   *  must read the new error off the rejection, not off the result. */
  onboardingBoot: () =>
    request<{ booted: boolean; error?: string }>("/api/onboarding/boot", { method: "POST", body: "{}" }),
  attention: () => request<AttentionItem[]>("/api/attention"),
  health: () => request<HealthInfo>("/api/health"),
  org: () => request<OrgDepartmentView[]>("/api/org"),
  agent: (name: string) => request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}`),
  hireAgent: (body: { name: string; department: string; kind: string; title: string; charter: string; persona: string; prompt: string; capabilities: string[] }) =>
    request<AgentProfileInfo>("/api/agents", { method: "POST", body: JSON.stringify(body) }),
  growOrg: (turns: Array<{ role: "user" | "architect"; text: string }>) =>
    request<{ done: false; question: string } | { done: true; proposal: OrgGrowthProposal }>(
      "/api/org/grow", { method: "POST", body: JSON.stringify({ turns }) }),
  draftDepartment: (description: string) =>
    request<{ proposal: OrgGrowthProposal }>("/api/org/draft-department",
      { method: "POST", body: JSON.stringify({ description }) }),
  applyOrgGrowth: (proposal: OrgGrowthProposal) =>
    request<{ ok: true; departments: string[]; agents: string[] }>(
      "/api/org/grow/apply", { method: "POST", body: JSON.stringify({ proposal }) }),
  createDepartment: (body: {
    department: string; mission: string; memoDomain: string;
    capabilities: string[]; playbooks: string[];
  }) => request<{ department: string; agents: string[] }>("/api/departments", { method: "POST", body: JSON.stringify(body) }),
  retireAgent: (name: string) =>
    request<{ ok: true; archived: string }>(`/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" }),
  retiredAgents: () =>
    request<Array<{ name: string; department?: string; kind?: string; title?: string; error?: string }>>("/api/agents/retired"),
  rehireAgent: (name: string) =>
    request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}/rehire`, { method: "POST" }),
  agentActivity: (name: string) =>
    request<AgentActivityInfo>(`/api/agents/${encodeURIComponent(name)}/activity`),
  patchAgentManifest: (name: string, field: string, value: string | number) =>
    request<AgentProfileInfo>(`/api/agents/${encodeURIComponent(name)}/manifest`, {
      method: "PATCH", body: JSON.stringify({ field, value }),
    }),
  goals: () => request<GoalView[]>("/api/goals"),
  goal: (idOrSlug: string) => request<GoalDetail>(`/api/goals/${encodeURIComponent(idOrSlug)}`),
  goalAction: (idOrSlug: string, verb: "pause" | "resume" | "abandon" | "reopen", body?: { guidance?: string }) =>
    request<{ message: string }>(`/api/goals/${encodeURIComponent(idOrSlug)}/${verb}`,
      { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }),
  /** `force` waives the accept-turnstile (failing verification / missing artifact). Older
   *  servers ignore the flag, so a new bundle against one still behaves exactly as before. */
  resolveReview: (goalId: string, node: string, verdict: "accept" | "retry" | "abandon", guidance?: string, force?: boolean) =>
    request<{ message: string }>(
      `/api/goals/${encodeURIComponent(goalId)}/review/${encodeURIComponent(node)}`,
      { method: "POST", body: JSON.stringify({ verdict, ...(guidance?.trim() ? { guidance } : {}), ...(force ? { force: true } : {}) }) },
    ),
  /** `since` (ISO) makes the server bound by time instead of row count — a row limit over the
   *  whole corpus silently drops the oldest days out of a window. */
  mail: (agent?: string, limit = 50, since?: string) =>
    request<MailView[]>(`/api/mail?${agent ? `agent=${encodeURIComponent(agent)}&` : ""}${
      since ? `since=${encodeURIComponent(since)}&` : ""}limit=${limit}`),
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
  libraryTree: () => request<{ nodes: LibraryNode[] }>("/api/library/tree"),
  libraryShelf: () => request<ShelfView>("/api/library/shelf"),
  libraryWiki: () => request<WikiView>("/api/library/wiki"),
  librarySearch: (q: string) =>
    request<{ q: string; hits: LibrarySearchHit[] }>(`/api/library/search?q=${encodeURIComponent(q)}`),
  libraryText: async (path: string): Promise<string> => (await libraryFile(path)).text(),
  /** An <img>/<embed> src cannot send a bearer header, so binaries are fetched here as a blob
   *  URL the browser can point an element at. The caller owns revoking it. */
  libraryBlobUrl: async (path: string): Promise<string> =>
    URL.createObjectURL(await (await libraryFile(path)).blob()),
  /** The bytes themselves, for callers that must inspect before choosing a viewer. */
  libraryBlob: async (path: string): Promise<Blob> => (await libraryFile(path)).blob(),
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
