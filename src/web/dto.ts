// src/web/dto.ts — the wire contract between the daemon's /api/* JSON and the React UI.
// Types only. Zero imports. Server view-builders implement these; ui/src/api.ts re-exports them.

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

/**
 * Two wire shapes share this one type. The setup-mode server sends `{ mode: "setup", step, booted }`
 * — plus `bootError` once an in-process boot has failed — and omits every field below those; the
 * cockpit sends those lower fields and omits `booted`/`bootError`. Consumers must branch
 * on `mode` before touching the cockpit fields — they are typed required but absent in setup mode.
 * Splitting this into a discriminated union is planned for plan 2.
 */
export interface StateInfo {
  /** "setup" while the onboarding wizard owns the UI; "normal" for the cockpit. */
  mode?: "setup" | "normal";
  /** Current wizard step when mode === "setup". */
  step?: string;
  /** Setup mode only: has the daemon been booted in-process yet? */
  booted?: boolean;
  /** Setup mode only: why the in-process boot failed, when it did. */
  bootError?: string;
  uptimeMs: number;
  voice: boolean;
  /** AIOS_FULL_AUTONOMY=1 — unguarded, non-sandbox agents run bypassPermissions. Absent on
   *  older servers and in setup mode; the UI treats undefined as off. */
  fullAutonomy?: boolean;
  agents: AgentInfo[];
  playbooks: Array<{ name: string; description: string }>;
  bindings: Array<{ chatKey: string; agents: string[]; mentionOnly: boolean }>;
  /** Capability names hire can grant (agents/_capabilities.yaml keys). */
  capabilities: string[];
}

export interface StoredEvent {
  id: number;
  ts: string;
  event: Record<string, unknown> & { type: string };
}

/** Media the browser fetches by capability token from /api/attachment/:token. */
export interface WebAttachment {
  token: string;
  name: string;
  mime: string;
  caption?: string;
  kind?: "voice";
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
  shadowMatches: number;
  firstSeen: string;
  lastRejection: string | null;
  graduatedAt: string | null;
  /** Shadow scoring across all resolved graduating-era actions (matches = approved, mismatches = rejected). */
  matches?: number;
  mismatches?: number;
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
  /**
   * Most recent day this agent did anything — max across cost, nodes, mail,
   * goals led AND completed runs. `null` means it has never run under ANY of
   * its names.
   *
   * Runs are load-bearing here, not a refinement: a chat-only agent produces no
   * goal, node or mail, and 65% of agent.end events carry no cost. Reading the
   * four artifact sources alone reports the busiest agent in the org as weeks
   * stale and an entire department as never having run.
   *
   * A DATE (YYYY-MM-DD), not a timestamp: cost_daily is day-granular, so a
   * full ISO stamp would be false precision on one of the four inputs.
   */
  lastActiveAt: string | null;
  /** Lifetime, aliases folded in. `costTodayUsd` is ~always 0 and cannot carry the card. */
  costUsd: number;
  nodes: number;
  goalsLed: number;
  mail: number;
  /** Completed runs (agent.end). The only activity a chat-only agent produces. */
  runs: number;
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
  /** Org role: coordinator | lead | worker | critic. */
  kind: string;
  /** Effective capability names (dept defaults ∪ agent extras). */
  capabilities: string[];
  /** The manifest system prompt, verbatim. */
  prompt: string;
  model: string | null;
  skills: string[];
  guarded: boolean;
  maxTurns: number;
  tools: Array<{ name: string; source: "default" | "granted" }>;
  revoked: Array<{ name: string; source: "revoked" }>;
  /** Every known tool this agent does NOT currently have, for the grant picker.
   *  `from` is the capability that provides it, or "builtin" for an SDK tool. */
  grantable: Array<{ name: string; from: string }>;
  trust: TrustInfo[];
  recentRuns: Array<{ ts: string; context: string; ok: boolean; costUsd: number | null }>;
  handoffs: Array<{ ts: string; reason: string; channel: string; chatId: string }>;
  costByDay: Record<string, number>;
}

export interface AgentActivityInfo {
  /** Merged per-agent event feed, newest first, capped at 100. */
  timeline: Array<{ ts: string; kind: "run" | "route" | "mail" | "goal"; summary: string; ok?: boolean }>;
  /** Goals with at least one node assigned to the agent; nodes filtered to the agent's. */
  goals: Array<{ goalId: string; title: string; status: string; nodes: Array<{ key: string; status: string }> }>;
  /** Agent mail involving this agent (from or to), newest first. */
  mail: Array<{ id: string; ts: string; from: string; to: string; kind: string; snippet: string; status: string }>;
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

export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
  brief: string;
  deps: string[]; status: string; costCents: number; rounds: number;
  artifact: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}

export interface GoalView {
  id: string; slug: string; title: string; department: string; lead: string;
  originChannel: string;
  status: string; planSummary: string; replansUsed: number; error: string | null;
  createdAt: string; updatedAt: string; projectDir: string | null; goalDir: string | null;
  nodes: GoalNodeView[];
}

/** Wizard first-job step: what the coordinator is doing with the suggested job. */
export interface FirstJobStatus {
  status: "idle" | "running" | "done" | "failed";
  request?: string;
  reply?: string;
  error?: string;
  goals: GoalView[];
  /** Vault files that appeared while the job ran, relative to the workspace folder. The reply is
   *  prose; this is where the deliverable actually landed, which is what the user goes looking
   *  for once the wizard is gone. */
  wrote?: string[];
}

export interface GoalDetail extends GoalView {
  artifacts: Array<{ file: string; content: string }>;
  spawnedBy: { mailId: string; from: string } | null;
  awaitingUserAsk: { mailId: string; question: string; from: string } | null;
}

export interface MailView {
  id: string; from: string; to: string; kind: string; status: string; body: string;
  goalId: string | null; chainDepth: number; createdAt: string; readAt: string | null; error: string | null;
}

export interface UserThreadView {
  threadId: string; lastTs: string; lastFrom: string; lastBody: string; unread: number; pendingAsk: number; refused: number;
}

export interface BudgetInfo { date: string; spentCents: number; capCents: number | null }

/** One row of the unified needs-you queue (Ember Cockpit spec §5, §9.1). */
export interface AttentionItem {
  kind: "approval" | "review" | "ask" | "goal" | "mail" | "sense";
  id: string;
  title: string;
  meta: string;
  /** 1 approvals · 2 reviews + asks · 3 failed/paused goals · 4 unread mail · 5 ambient. */
  severity: 1 | 2 | 3 | 4 | 5;
  ts: string;
  /** Inline verbs the row offers: approve, reject, accept, retry, answer, open, read, resume, abandon. */
  actions: string[];
  /** Kind-specific pointers the canvas needs (actionId, mailId, threadId, goalId, node, slug, status, sense, artifact). */
  ref: Record<string, string>;
  /** Proposed permission.grant actions folded into this review row (policy-wall park —
   *  triage-inbox spec §A): one human decision, one row. */
  grants?: Array<{ id: string; role: string; tool: string }>;
}

/** GET /api/health (already served; typed here so ui2 can consume it). */
export interface HealthInfo {
  uptimeMs: number;
  voice: boolean;
  senses: Array<{ name: string; ok: boolean; reason?: string }>;
  sseClients: number;
  dbBytes: number;
  /** Information-flow policy posture (audit logs, enforce blocks). */
  policyMode: string;
  /** Count of policy.violation events observed (the audit-week signal). */
  /** DISTINCT info-flow refusals in the scanned window, not raw events — a reconcile replays
   *  the same denied mail threads every boot, so the raw count grows with uptime alone. */
  policyViolations: number;
  /** ISO ts the scanned window starts at, so the count can name its window. Null when empty. */
  policyViolationsSince: string | null;
}

// ---- schedule (spec 2026-07-15) ----
export type { Recurrence } from "../heartbeat/routines.js";
import type { Recurrence as RecurrenceT } from "../heartbeat/routines.js";

export interface AnchorView {
  name: string;
  /** Effective time — kv override when set, config default otherwise. */
  hhmm: string;
  overridden: boolean;
  firedToday: boolean;
}

export interface RoutineView {
  id: number;
  name: string;
  prompt: string;
  recurrence: RecurrenceT;
  enabled: boolean;
  lastFiredAt: string | null;
  /** Local "YYYY-MM-DD HH:MM", display-only. */
  nextFire: string | null;
}

export interface ScheduleReminderView {
  id: number;
  text: string;
  dueAt: string;
  origin: string;
}

export interface ScheduleView {
  anchors: AnchorView[];
  routines: RoutineView[];
  reminders: ScheduleReminderView[];
}

// ---- skills manager (spec 2026-07-15 skills-manager) ----
export interface SkillView {
  name: string;
  description: string;
  /** Agent (manifest) names whose role declares this skill. */
  usedBy: string[];
}

// ---- library (read-only workspace browser, spec 2026-08-01 value-path §4) ----
/** One entry in the read-only workspace browser. `path` is vault-relative. */
export interface LibraryNode {
  name: string; path: string; dir: boolean; size: number;
  /** Last-modified ISO stamp. The tree already stat()s every entry, so this is free —
   *  and without it the archive can only be sorted by name, never by what changed. */
  mtime: string;
  children?: LibraryNode[];
}

// ---- wiki (the LLM Wiki reading room) ----
/** One wiki page. `path` is the vault-relative path /api/library/file serves, so the reader
 *  needs no second address scheme; `name` is the basename, which is what `[[links]]` resolve on. */
export interface WikiPageView {
  name: string;
  path: string;
  section: string;
  /** First `# ` heading, falling back to the basename. */
  title: string;
  /** Frontmatter `type` (entity/concept/topic/source/analysis) — null when absent. */
  type: string | null;
  updated: string;
  /** Resolved outbound page names, deduped. */
  outbound: string[];
  /** Page names that link HERE. No inbound = orphan; no outbound = dead end. Both are bugs
   *  per the wiki schema, so the reader shows them rather than hiding them. */
  backlinks: string[];
}

export interface WikiSectionView {
  name: string;
  pages: WikiPageView[];
}

/** An unresolved `[[link]]`. Intra-page `[[#anchor]]` refs are not links and never appear. */
export interface WikiBrokenLink { from: string; link: string }

export interface WikiView {
  sections: WikiSectionView[];
  /** Vault-relative paths for the two hand-maintained roots, or null when absent. */
  index: string | null;
  log: string | null;
  /** `links` counts EDGES attempted — distinct targets per page, so a page naming the same
   *  target five times contributes one. A raw grep for `[[` gives a larger number (2428 vs
   *  3274 on the live wiki); this is the graph measure, not the mention count. */
  totals: { pages: number; links: number; orphans: number; deadEnds: number };
  broken: WikiBrokenLink[];
}

/** One search hit. `path` is the vault-relative path, so a hit opens like any other file. */
export interface LibrarySearchHit {
  path: string; title: string; snippet: string; score: number; ts: string;
  /** True when the hit is under `wiki/` — the reading room, as opposed to the record. */
  wiki: boolean;
}
