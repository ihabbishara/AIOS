// src/engine/project.ts — materialized projections. goals/task_nodes are a read cache of
// the journal, maintained per event IN THE SAME TRANSACTION as the append (journal.ts
// calls this). Shapes are byte-compatible with the legacy engine so dto.ts, goals-view,
// Mission Control, moderator tools and /api/goals are untouched. Never write these
// tables from anywhere else for journal-backed goals.
import type { Store, NewTaskNode } from "../store/db.js";
import type {
  JournalEvent, NodeSpec,
  GoalCreatedPayload, PlanRecordedPayload, ReplanRecordedPayload,
  WorkspacePreparedPayload, AttemptStartedPayload, RoundRecordedPayload,
  AttemptFinishedPayload, NodeCompletedPayload,
  ReviewRequestedPayload, ReviewResolvedPayload,
} from "./journal.js";
import { pausedStatus } from "./journal.js";

const toRow = (n: NodeSpec): NewTaskNode => ({
  node_key: n.key, type: n.kind, agent: n.agent, critic: n.critic,
  brief: n.brief, depends_on: n.dependsOn, max_rounds: n.maxRounds,
});

/** Derived 'ready': pending nodes whose deps are all done (UI shape preserved). */
function refreshReady(store: Store, goalId: string): void {
  const nodes = store.listNodes(goalId);
  const done = new Set(nodes.filter((n) => n.status === "done").map((n) => n.node_key));
  for (const n of nodes) {
    if (n.status === "pending" && (JSON.parse(n.depends_on) as string[]).every((d) => done.has(d))) {
      store.updateNodeStatus(goalId, n.node_key, "ready");
    }
  }
}

export function projectEvent(store: Store, ev: JournalEvent): void {
  const goalId = ev.goalId;
  switch (ev.type) {
    case "goal.created": {
      const p = ev.payload as unknown as GoalCreatedPayload;
      store.insertGoal({
        id: goalId, slug: p.slug, title: p.title, request: p.request, department: p.department,
        lead: p.lead, origin_channel: p.origin.channel, origin_chat_id: p.origin.chatId,
        status: "running", project_dir: p.projectDir, goal_dir: p.goalDir,
        plan_summary: p.planSummary, replans_used: 0, chain_depth: p.chainDepth,
        spawned_by_mail: p.spawnedByMail, error: null,
      });
      return;
    }
    case "plan.recorded": {
      const p = ev.payload as unknown as PlanRecordedPayload;
      store.insertNodes(goalId, p.nodes.map(toRow));
      refreshReady(store, goalId);
      return;
    }
    case "replan.recorded": {
      const p = ev.payload as unknown as ReplanRecordedPayload;
      for (const n of p.replaced) store.replaceNode(goalId, n.key, toRow(n));
      if (p.added.length) store.insertNodes(goalId, p.added.map(toRow));
      for (const r of p.retargets) store.updateNodeDeps(goalId, r.node, r.dependsOn);
      if (p.kind === "replan") store.bumpReplans(goalId);
      refreshReady(store, goalId);
      return;
    }
    case "workspace.prepared": {
      const p = ev.payload as unknown as WorkspacePreparedPayload;
      if (p.taskDir) store.setGoalProjectDir(goalId, p.taskDir);
      else if (p.stripped) store.setGoalProjectDir(goalId, null);
      return;
    }
    case "workspace.failed":
      return; // goal.failed follows in the same command cycle
    case "attempt.started": {
      const p = ev.payload as unknown as AttemptStartedPayload;
      store.updateNodeStatus(goalId, p.node, "running");
      return;
    }
    case "round.recorded": {
      const p = ev.payload as unknown as RoundRecordedPayload;
      store.setNodeRounds(goalId, p.node, p.round);
      return;
    }
    case "attempt.finished": {
      const p = ev.payload as unknown as AttemptFinishedPayload;
      if (p.costCents) store.addNodeCost(goalId, p.node, p.costCents);
      // The attempt no longer runs: mirror the derived state (ready) until node.completed /
      // node.failed lands — for ok outcomes that's the very next event in the same batch.
      const row = store.listNodes(goalId).find((n) => n.node_key === p.node);
      if (row?.status === "running") {
        store.updateNodeStatus(goalId, p.node, "ready", p.outcome === "ok" ? undefined : (p.error ?? p.outcome));
      }
      return;
    }
    case "node.completed": {
      const p = ev.payload as unknown as NodeCompletedPayload;
      store.setNodeArtifact(goalId, p.node, p.artifactRef);
      if (p.roundsUsed) store.setNodeRounds(goalId, p.node, p.roundsUsed);
      store.updateNodeStatus(goalId, p.node, "done");
      refreshReady(store, goalId);
      return;
    }
    case "node.failed": {
      const p = ev.payload as { node: string; error?: string };
      store.updateNodeStatus(goalId, p.node, "failed", p.error);
      return;
    }
    case "node.skipped": {
      const p = ev.payload as { node: string };
      const row = store.listNodes(goalId).find((n) => n.node_key === p.node);
      if (row && (row.status === "pending" || row.status === "ready")) {
        store.updateNodeStatus(goalId, p.node, "skipped");
      }
      return;
    }
    case "review.requested": {
      const p = ev.payload as unknown as ReviewRequestedPayload;
      // artifact = last produced version so the UI can show it while parked;
      // node.completed overwrites it with the final file on accept.
      store.setNodeArtifact(goalId, p.node, p.lastArtifactRef);
      store.updateNodeStatus(goalId, p.node, "needs-review", p.objections.join("; ") || undefined);
      return;
    }
    case "review.resolved": {
      const p = ev.payload as unknown as ReviewResolvedPayload;
      if (p.verdict === "retry") store.updateNodeStatus(goalId, p.node, "ready");
      return; // accept → node.completed / abandon → node.failed project in the same batch
    }
    case "ask.parked": {
      const p = ev.payload as { node: string | null; mailId: string };
      if (p.node) store.updateNodeStatus(goalId, p.node, "done");
      store.parkGoalAwaiting(goalId, p.mailId);
      return;
    }
    case "ask.resumed":
      store.clearAwaiting(goalId);
      store.updateGoalStatus(goalId, "running");
      return;
    case "goal.paused": {
      const p = ev.payload as { reason: "budget" | "user" | "api" | "session"; error?: string };
      store.updateGoalStatus(goalId, pausedStatus(p.reason), p.error);
      return;
    }
    case "goal.resumed":
      store.updateGoalStatus(goalId, "running");
      return;
    case "goal.reopened": {
      // The store must agree with the fold (goal-resurrection spec §1): without this case the
      // engine folds "running" while the goals table — and every UI reading it — says "failed".
      // updateGoalStatus writes `error ?? null`, so the stale failure message clears here too.
      store.updateGoalStatus(goalId, "running");
      for (const n of store.listNodes(goalId)) {
        if (n.status === "failed" || n.status === "skipped") {
          store.updateNodeStatus(goalId, n.node_key, "pending");
        }
      }
      return;
    }
    case "goal.completed":
      store.updateGoalStatus(goalId, "done");
      return;
    case "goal.failed":
      store.clearAwaiting(goalId); // a parked goal failing must not leave a dangling ask
      store.updateGoalStatus(goalId, "failed", String((ev.payload as { error: string }).error));
      return;
    case "goal.abandoned":
      store.clearAwaiting(goalId);
      store.updateGoalStatus(goalId, "abandoned");
      return;
  }
}
