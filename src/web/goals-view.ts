// src/web/goals-view.ts — pure builders behind /api/goals and /api/budget.
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpendGuard } from "../engine/budget.js";

export interface GoalNodeView {
  key: string; type: string; agent: string; critic: string | null;
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
  return { ...goalView(g, store), artifacts };
}

export function buildBudgetView(guard: SpendGuard, todayFn?: () => string) {
  const date = (todayFn ?? (() => new Date().toISOString().slice(0, 10)))();
  return { date, spentCents: guard.spentCents(date), capCents: guard.capCents() };
}
