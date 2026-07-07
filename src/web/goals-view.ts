// src/web/goals-view.ts — pure builders behind /api/goals and /api/budget.
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpendGuard } from "../engine/budget.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { localParts } from "../heartbeat/clock.js";

export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
  brief: string;
  deps: string[]; status: string; costCents: number; rounds: number;
  artifact: string | null; error: string | null; startedAt: string | null; finishedAt: string | null;
}
export interface GoalView {
  id: string; slug: string; title: string; department: string; lead: string;
  status: string; planSummary: string; replansUsed: number; error: string | null;
  createdAt: string; updatedAt: string; projectDir: string | null; goalDir: string | null;
  nodes: GoalNodeView[];
}

function nodeView(n: TaskNodeRow): GoalNodeView {
  return {
    key: n.node_key, type: n.type, agent: n.agent, critic: n.critic,
    brief: n.brief,
    deps: JSON.parse(n.depends_on) as string[], status: n.status,
    costCents: n.cost_cents, rounds: n.rounds_used, artifact: n.artifact,
    error: n.error, startedAt: n.started_at, finishedAt: n.finished_at,
  };
}

function goalView(g: GoalRow, store: Store): GoalView {
  return {
    id: g.id, slug: g.slug, title: g.title, department: g.department, lead: g.lead,
    status: g.status, planSummary: g.plan_summary, replansUsed: g.replans_used, error: g.error,
    createdAt: g.created_at, updatedAt: g.updated_at, projectDir: g.project_dir, goalDir: g.goal_dir,
    nodes: store.listNodes(g.id).map(nodeView),
  };
}

export function buildGoalsView(store: Store, limit = 50): GoalView[] {
  return store.listGoals(limit).map((g) => goalView(g, store));
}

export function buildGoalDetail(store: Store, vault: VaultWriter, idOrSlug: string) {
  const g = store.getGoal(idOrSlug) ?? store.getGoalBySlug(idOrSlug);
  if (!g) return null;
  const artifacts = !g.goal_dir ? [] : store.listNodes(g.id)
    .filter((n) => n.artifact)
    .map((n) => ({ file: n.artifact!, content: vault.readGoalArtifact(g.goal_dir!, n.artifact!) ?? "" }));
  const spawnedBy = g.spawned_by_mail
    ? (() => {
        const m = store.getMail(g.spawned_by_mail!);
        return m ? { mailId: m.id, from: m.from_agent } : null;
      })()
    : null;
  const askMail = g.awaiting_mail ? store.getMail(g.awaiting_mail) : undefined;
  const awaitingUserAsk =
    askMail && askMail.to_agent === "user" && askMail.status === "awaiting-human" &&
    !store.mailAnsweringRequest(askMail.id)
      ? { mailId: askMail.id, question: askMail.body, from: askMail.from_agent }
      : null;
  return { ...goalView(g, store), artifacts, spawnedBy, awaitingUserAsk };
}

export interface MailView {
  id: string; from: string; to: string; kind: string; status: string; body: string;
  goalId: string | null; chainDepth: number; createdAt: string; readAt: string | null; error: string | null;
}

export function buildMailView(store: Store, registry: LoadedRegistry, agent?: string, limit = 50): MailView[] {
  const canonical = agent ? registry.agentOf.get(agent) ?? agent : undefined;
  return store.listMail(canonical, limit).map((m) => ({
    id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, status: m.status, body: m.body,
    goalId: m.goal_id, chainDepth: m.chain_depth, createdAt: m.created_at, readAt: m.read_at, error: m.error,
  }));
}

/** All mail in one conversation, oldest first — the thread read view (spec §8). */
export function buildMailThread(store: Store, threadId: string): MailView[] {
  return store.mailThread(threadId).map((m) => ({
    id: m.id, from: m.from_agent, to: m.to_agent, kind: m.kind, status: m.status, body: m.body,
    goalId: m.goal_id, chainDepth: m.chain_depth, createdAt: m.created_at, readAt: m.read_at, error: m.error,
  }));
}

/** Unread inbound mail per agent + grand total + questions waiting on the human. */
export function buildMailUnread(store: Store): { total: number; byAgent: Record<string, number>; pendingUser: number; userInbox: number } {
  const byAgent = store.unreadCountsByAgent();
  const total = Object.values(byAgent).reduce((s, n) => s + n, 0);
  return { total, byAgent, pendingUser: store.pendingUserAsks().length, userInbox: store.unreadUserInbox() };
}

export interface UserThreadView {
  threadId: string; lastTs: string; lastFrom: string; lastBody: string; unread: number; pendingAsk: number;
}

/** The human's correspondence — thread summaries for the Mail tab (spec §6). */
export function buildUserThreads(store: Store): UserThreadView[] {
  return store.userThreads().map((t) => ({
    threadId: t.thread_id, lastTs: t.last_ts, lastFrom: t.last_from, lastBody: t.last_body,
    unread: t.unread, pendingAsk: t.pending_ask,
  }));
}

export function buildBudgetView(guard: SpendGuard, todayFn?: () => string) {
  // Local date, not UTC — the ledger stamps localParts dates (mismatch showed 0 spend after local midnight).
  const date = (todayFn ?? (() => localParts(new Date()).date))();
  return { date, spentCents: guard.spentCents(date), capCents: guard.capCents() };
}
