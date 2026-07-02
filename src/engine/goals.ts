// src/engine/goals.ts — the unified GoalEngine: node runner (this half) + scheduler (Task 6).
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { ResolvedPack } from "../packs/resolve.js";
import type { AiosEvent } from "../events.js";

const ARTIFACT_CHAR_LIMIT = 12_000;

export class SessionLimitError extends Error {
  readonly name = "SessionLimitError";
}

const SESSION_LIMIT_PATTERNS = ["you've hit your session limit", "hit your session limit"] as const;
function isSessionLimitOutput(text: string): boolean {
  const lower = text.toLowerCase().trimStart();
  return SESSION_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

export interface Verdict { verdict: "approve" | "revise"; summary: string; reasons: string[] }
export interface TestReport { passed: boolean; summary: string; failures: string[] }

function truncate(text: string, limit = ARTIFACT_CHAR_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[...truncated]`;
}

/** Transitive dependency closure of `key`, restricted to done nodes with an artifact. */
export function ancestorArtifacts(nodes: TaskNodeRow[], key: string): TaskNodeRow[] {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const seen = new Set<string>();
  const walk = (k: string) => {
    for (const dep of JSON.parse(byKey.get(k)?.depends_on ?? "[]") as string[]) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(key);
  return nodes.filter((n) => seen.has(n.node_key) && n.status === "done" && n.artifact);
}

export interface NodeRunDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  model?: string;
  log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  resolvePack: (node: TaskNodeRow, goal: GoalRow) => ResolvedPack | undefined;
}

function contextBlock(goal: GoalRow, ancestors: TaskNodeRow[], vault: VaultWriter): string {
  const parts = [
    `# Task\n${goal.request}`,
    goal.project_dir ? `# Working directory\n${goal.project_dir}` : "",
  ];
  for (const a of ancestors) {
    const content = vault.readGoalArtifact(goal.goal_dir!, a.artifact!) ?? "";
    parts.push(`# Prior artifact: ${a.artifact} (by ${a.agent})\n${truncate(content)}`);
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

async function runAgent(
  goal: GoalRow, node: TaskNodeRow, role: string, brief: string, deps: NodeRunDeps,
) {
  const context = `goal:${goal.slug}/${node.node_key}`;
  deps.onEvent?.({ type: "agent.start", agent: role, context });
  try {
    const res = await deps.run(role, brief, {
      cwd: goal.project_dir ?? process.cwd(),
      model: deps.model,
      pack: deps.resolvePack(node, goal),
    });
    if (isSessionLimitOutput(res.text)) {
      deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
      throw new SessionLimitError("Agent hit session limit — re-run after quota resets");
    }
    deps.onEvent?.({ type: "agent.end", agent: role, context, ok: true, costUsd: res.costUsd, turns: res.numTurns });
    if (res.costUsd) deps.store.addNodeCost(goal.id, node.node_key, Math.round(res.costUsd * 100));
    return res;
  } catch (err) {
    if (!(err instanceof SessionLimitError)) {
      deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
    }
    throw err;
  }
}

function save(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps, role: string, file: string, content: string): void {
  deps.vault.writeGoalArtifact(goal.goal_dir!, file, content, { goal: goal.id, node: node.node_key, role });
}

function finalArtifact(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps, role: string, content: string): void {
  const file = `${node.node_key}.md`;
  save(goal, node, deps, role, file, content);
  deps.store.setNodeArtifact(goal.id, node.node_key, file);
}

async function runOnce(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps): Promise<void> {
  const { store, vault } = deps;
  const ctx = contextBlock(goal, ancestorArtifacts(store.listNodes(goal.id), node.node_key), vault);
  const mkdirCwd = () => goal.project_dir; // cwd creation handled by makeRunSpecialist path via runner cwd; project dirs are pre-created at goal start (Task 6)
  void mkdirCwd;

  switch (node.type) {
    case "run": {
      const brief = [node.brief, ctx].filter(Boolean).join("\n\n");
      const res = await runAgent(goal, node, node.agent, brief, deps);
      finalArtifact(goal, node, deps, node.agent, res.text);
      return;
    }
    case "loop": {
      let feedback = "";
      let lastOutput = "";
      let approved = false;
      let rounds = 0;
      for (let round = 1; round <= node.max_rounds; round++) {
        rounds = round;
        const producerBrief = [
          node.brief, ctx,
          feedback ? `# Reviewer feedback (round ${round - 1}) — address every point\n${feedback}` : "",
          lastOutput ? `# Your previous version\n${truncate(lastOutput)}` : "",
        ].filter(Boolean).join("\n\n");
        const produced = await runAgent(goal, node, node.agent, producerBrief, deps);
        lastOutput = produced.text;
        save(goal, node, deps, node.agent, `${node.node_key}-v${round}.md`, produced.text);

        const criticBrief = [
          `Review the following ${node.agent} output against the original task.`,
          ctx,
          `# Output under review (round ${round})\n${truncate(produced.text)}`,
        ].join("\n\n");
        const review = await runAgent(goal, node, node.critic!, criticBrief, deps);
        const verdict = review.structured as Verdict | undefined;
        save(goal, node, deps, node.critic!, `${node.node_key}-review-${round}.md`,
          verdict ? `**Verdict:** ${verdict.verdict}\n\n${verdict.summary}\n\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}` : review.text);

        if (verdict?.verdict === "approve") { approved = true; break; }
        feedback = verdict ? [verdict.summary, ...verdict.reasons].join("\n- ") : review.text;
      }
      deps.store.setNodeRounds(goal.id, node.node_key, rounds);
      const note = approved ? "" : `\n\n> [!warning] Loop cap reached (${node.max_rounds} rounds) without approval — proceeding with last version.\n`;
      finalArtifact(goal, node, deps, node.agent, lastOutput + note);
      return;
    }
    case "verify": {
      let report: TestReport | undefined;
      let rounds = 0;
      for (let round = 1; round <= node.max_rounds; round++) {
        rounds = round;
        const runnerBrief = [node.brief, ctx, "Run the verification now."].filter(Boolean).join("\n\n");
        const res = await runAgent(goal, node, node.agent, runnerBrief, deps);
        report = res.structured as TestReport | undefined;
        save(goal, node, deps, node.agent, `${node.node_key}-run-${round}.md`,
          report ? `**Passed:** ${report.passed}\n\n${report.summary}\n\n${report.failures.map((f) => `- ${f}`).join("\n")}` : res.text);

        if (!report || report.passed) break;
        if (round === node.max_rounds) break;

        const fixBrief = [
          ctx,
          `# Failing verification (round ${round}) — fix these\n${report.summary}\n${report.failures.map((f) => `- ${f}`).join("\n")}`,
        ].join("\n\n");
        const fix = await runAgent(goal, node, node.critic!, fixBrief, deps);
        save(goal, node, deps, node.critic!, `${node.node_key}-fix-${round}.md`, fix.text);
      }
      deps.store.setNodeRounds(goal.id, node.node_key, rounds);
      const summary = report
        ? `**Passed:** ${report.passed}\n\n${report.summary}${report.failures.length ? `\n\nFailures:\n${report.failures.map((f) => `- ${f}`).join("\n")}` : ""}`
        : "No structured test report produced.";
      finalArtifact(goal, node, deps, node.agent, summary);
      if (report && !report.passed) {
        deps.log?.(`node ${node.node_key}: verification still failing after ${node.max_rounds} rounds`);
      }
      return;
    }
  }
}

/** Runs one node to completion. Retries once on non-quota errors (port of runStageWithRetry). */
export async function runNode(goal: GoalRow, node: TaskNodeRow, deps: NodeRunDeps): Promise<void> {
  try {
    await runOnce(goal, node, deps);
  } catch (err) {
    if (err instanceof SessionLimitError) throw err;
    deps.log?.(`node ${node.node_key}: failed (${(err as Error).message}), retrying once`);
    await runOnce(goal, node, deps);
  }
}
