// src/engine/goals.ts — the unified GoalEngine: node runner (this half) + scheduler (Task 6).
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Store, GoalRow, TaskNodeRow, GoalStatus, NodeStatus, NewTaskNode, MailRow } from "../store/db.js";
import { isPrivateOrigin } from "../agents/direct.js";
import { slugify, type VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { ResolvedPack } from "../packs/resolve.js";
import type { AiosEvent } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { Playbook } from "./playbook.js";
import { compilePlaybook, toNewTaskNodes } from "./compile.js";
import type { Stage } from "./playbook.js";
import { assertInplaceTarget, resolveReal } from "../code/paths.js";
import type { SpendGuard } from "./budget.js";

/** All role names a stage references, across every stage shape. */
export function stageRoles(stage: Stage): string[] {
  switch (stage.type) {
    case "single": return [stage.role];
    case "loop": return [stage.producer, stage.critic];
    case "verify": return [stage.runner, stage.fixer];
  }
}

/** A playbook is "unsandboxed-write" iff it is packless (no owning department) AND a stage uses a
 *  bypassPermissions role — the in-place coding path that must be gated. */
export function isUnsandboxedWrite(pb: Playbook, ownerOf?: Map<string, string>, registry?: LoadedRegistry): boolean {
  if (!registry) throw new Error("isUnsandboxedWrite: registry is required (fail-closed)");
  if (ownerOf?.get(pb.name)) return false;
  return pb.stages.some((st) => stageRoles(st).some((r) => {
    const agentName = registry.agentOf.get(r) ?? r;
    return registry.agents.get(agentName)?.role.permissionMode === "bypassPermissions";
  }));
}

export interface Planner {
  plan(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow>;
  planFromMail(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }, mail: MailRow): Promise<GoalRow>;
  replan(goal: GoalRow, failed: TaskNodeRow, error: string): Promise<void>;
}

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
      mailCtx: { origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id }, goalDepth: goal.chain_depth, goalId: goal.id, nodeKey: node.node_key },
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

export interface GoalOutcome {
  goal: GoalRow; ok: boolean; error?: string; goalDirName: string; artifactFiles: string[];
}

export interface GoalEngineDeps extends Omit<NodeRunDeps, "resolvePack"> {
  registry: LoadedRegistry;
  playbooks: Map<string, Playbook>;
  wallTimeMs: number;
  maxConcurrentNodes: number;
  spendGuard: SpendGuard;
  onComplete: (o: GoalOutcome) => Promise<void>;
  resolveDeptFor: (key: string, origin: { channel: string; chatId: string }, byAgent?: boolean,
                   sandbox?: { taskDir: string; mode: "build" | "analyze" }) => ResolvedPack | undefined;
  prepareSandbox?: (goal: GoalRow, opts: { playbook?: Playbook }) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>;
  planner?: Planner;
  replanCap?: number;
  /** Chain-depth cap for mail-spawned goals (AIOS_MAIL_MAX_DEPTH). */
  mailMaxDepth: number;
  /** AIOS_MAIL_DISABLED — when true the sweep idles: queued mail stays queued (spec §11). */
  mailDisabled?: boolean;
  primaryChat?: { channel: string; chatId: string };
  projectsRoot?: string;
  workspaceRoot?: string;
  pingBudgetPaused?: (text: string) => void;
}

const FACADE_PREFIX = "playbook:";
/** plan_summary marker for mail-spawned goals (single node, never re-planned). */
export const MAIL_PREFIX = "mail:";

export class GoalEngine {
  private runningNodes = 0;
  private sandboxes = new Map<string, { taskDir: string; mode: "build" | "analyze" }>();

  constructor(private deps: GoalEngineDeps) {}

  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({
      name: p.name, description: p.description, pillar: this.deps.registry.ownerOfPlaybook.get(p.name),
    }));
  }

  private emit(e: AiosEvent): void { this.deps.onEvent?.(e); }
  private setGoalStatus(id: string, status: GoalStatus, error?: string): void {
    this.deps.store.updateGoalStatus(id, status, error);
    this.emit({ type: "goal.status", goalId: id, status, error });
  }
  private setNodeStatus(goal: GoalRow, key: string, status: NodeStatus, agent: string, error?: string): void {
    this.deps.store.updateNodeStatus(goal.id, key, status, error);
    this.emit({ type: "node.status", goalId: goal.id, nodeKey: key, status, agent, error });
  }

  createFromPlaybook(params: {
    playbook: string; title: string; request: string; projectDir?: string;
    channel: string; chatId: string; inplace?: boolean;
  }): GoalRow {
    const pb = this.deps.playbooks.get(params.playbook);
    if (!pb) throw new Error(`Unknown playbook: ${params.playbook}. Available: ${[...this.deps.playbooks.keys()].join(", ")}`);
    if (pb.needsProjectDir && !params.projectDir) throw new Error(`Playbook ${pb.name} needs a project directory (project_dir).`);
    if (isUnsandboxedWrite(pb, this.deps.registry.ownerOfPlaybook, this.deps.registry)) {
      if (!params.inplace) throw new Error(`Refused: "${pb.name}" is an unsandboxed in-place coding path; run it via the code_task tool (mode:inplace).`);
      if (!params.projectDir) throw new Error("Refused: inplace requires a project_dir.");
      if (!this.deps.projectsRoot || !this.deps.workspaceRoot) throw new Error("Refused: inplace is not configured (no projectsRoot/workspaceRoot).");
      assertInplaceTarget(params.projectDir, {
        selfRoot: resolveReal(process.cwd()),
        workspaceRoot: this.deps.workspaceRoot,
        projectsRoot: this.deps.projectsRoot,
      });
    }
    const dept = this.deps.registry.ownerOfPlaybook.get(params.playbook) ?? "operations";
    const lead = this.deps.registry.departments.get(dept)?.lead ?? "hermes";
    const goal = this.insertGoal({
      title: params.title, request: params.request, department: dept, lead,
      origin: { channel: params.channel, chatId: params.chatId },
      projectDir: params.projectDir, planSummary: `${FACADE_PREFIX}${params.playbook}`,
    });
    this.deps.store.insertNodes(goal.id, toNewTaskNodes(compilePlaybook(pb)));
    void this.startGoal(goal, pb);
    return goal;
  }

  private insertGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; projectDir?: string; planSummary: string;
    chainDepth?: number; spawnedByMail?: string;
  }): GoalRow {
    const id = randomUUID();
    const slug = slugify(p.title);
    this.deps.store.insertGoal({
      id, slug, title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin_channel: p.origin.channel, origin_chat_id: p.origin.chatId,
      status: "running", project_dir: p.projectDir ?? null, goal_dir: null,
      plan_summary: p.planSummary, replans_used: 0, chain_depth: p.chainDepth ?? 0,
      spawned_by_mail: p.spawnedByMail ?? null, error: null,
    });
    const goal = this.deps.store.getGoal(id)!;
    this.emit({ type: "goal.created", goalId: id, title: p.title, department: p.department });
    return goal;
  }

  /** Workspace + goal.md, then pump. Errors fail the goal (port of the prepareSandbox path). */
  private async startGoal(goal: GoalRow, pb?: Playbook): Promise<void> {
    const { store, vault } = this.deps;
    const goalDirName = vault.goalDirName(goal.slug);
    store.setGoalDir(goal.id, goalDirName);
    goal.goal_dir = goalDirName;
    vault.writeGoalArtifact(goalDirName, "goal.md",
      `# ${goal.title}\n\n- department: ${goal.department}\n- lead: ${goal.lead}\n- status: running\n\n## Request\n\n${goal.request}\n\n## Plan\n\n${goal.plan_summary}`,
      { goal: goal.id, department: goal.department });
    try {
      // Mail-spawned goals NEVER get a workspace/sandbox — code work enters ONLY via code_task
      // (spec §4). Enforced at the engine so it holds regardless of prepareSandbox's own gating.
      const sandbox = goal.spawned_by_mail
        ? undefined
        : await this.deps.prepareSandbox?.(goal, { playbook: pb });
      if (sandbox) {
        store.setGoalProjectDir(goal.id, sandbox.taskDir);
        goal.project_dir = sandbox.taskDir;
        this.sandboxes.set(goal.id, sandbox);
      }
      if (goal.project_dir) mkdirSync(goal.project_dir, { recursive: true });
    } catch (err) {
      const msg = `workspace setup failed: ${(err as Error).message}`;
      this.setGoalStatus(goal.id, "failed", msg);
      store.skipUnfinishedNodes(goal.id);
      await this.complete(goal, false, msg);
      return;
    }
    this.pump();
  }

  /** Core scheduler. Synchronous scan; async node runs re-enter via .finally(). */
  pump(): void {
    this.sweepMail();
    if (this.runningNodes >= this.deps.maxConcurrentNodes) return;
    for (const goal of this.deps.store.unfinishedGoals()) {
      if (goal.status !== "running") continue;
      const nodes = this.deps.store.listNodes(goal.id);
      // Wall-time counts from the last goal-level transition (updated_at), not created_at —
      // a budget-paused goal resumed next morning gets a fresh window instead of instant failure.
      if (Date.now() > new Date(goal.updated_at).getTime() + this.deps.wallTimeMs) {
        this.setGoalStatus(goal.id, "failed", "Goal wall-time budget exceeded");
        this.deps.store.skipUnfinishedNodes(goal.id);
        void this.complete(goal, false, "Goal wall-time budget exceeded");
        continue;
      }
      const done = new Set(nodes.filter((n) => n.status === "done").map((n) => n.node_key));
      for (const n of nodes) {
        if (n.status === "pending" && (JSON.parse(n.depends_on) as string[]).every((d) => done.has(d))) {
          this.setNodeStatus(goal, n.node_key, "ready", n.agent);
          n.status = "ready";
        }
      }
      for (const n of nodes.filter((x) => x.status === "ready")) {
        if (this.runningNodes >= this.deps.maxConcurrentNodes) return;
        if (!this.deps.spendGuard.allow()) { this.pauseForBudget(goal); break; }
        this.launch(goal, n);
      }
      // all terminal?
      const fresh = this.deps.store.listNodes(goal.id);
      if (fresh.every((n) => n.status === "done")) {
        this.setGoalStatus(goal.id, "done");
        void this.complete(this.deps.store.getGoal(goal.id)!, true);
        continue;
      }
      // Deadlock guard: still "running", nothing in flight, nothing schedulable → some
      // unfinished node depends (transitively) on a failed/skipped node. Fail loudly
      // instead of sitting "running" forever (a bad re-plan patch can produce this).
      const stillRunning = this.deps.store.getGoal(goal.id)?.status === "running";
      const anyActive = fresh.some((n) => n.status === "running" || n.status === "ready");
      if (stillRunning && !anyActive && fresh.some((n) => n.status === "pending")) {
        const msg = "stuck: unfinished nodes depend on failed/skipped nodes";
        this.setGoalStatus(goal.id, "failed", msg);
        this.deps.store.skipUnfinishedNodes(goal.id);
        void this.complete(this.deps.store.getGoal(goal.id)!, false, msg);
      }
    }
  }

  private pauseForBudget(goal: GoalRow): void {
    this.setGoalStatus(goal.id, "paused-budget");
    const date = new Date().toISOString().slice(0, 10);
    const key = `budget:pinged:${date}`;
    if (!this.deps.store.kvGet(key)) {
      this.deps.store.kvSet(key, "1");
      this.deps.pingBudgetPaused?.(`Daily budget reached — paused background goals; they resume tomorrow.`);
    }
  }

  /** Convert queued request mail into single-node goals (spec §4). FIFO; fail-soft per item. */
  private sweepMail(): void {
    if (this.deps.mailDisabled) return; // kill-switch: nothing spawns; queue drains on re-enable
    for (const m of this.deps.store.queuedRequests()) {
      // startGoal for a mail goal runs synchronously into pump() → sweepMail() re-enters and
      // may have already processed later items of THIS stale snapshot. Re-check the live row.
      if (this.deps.store.getMail(m.id)?.status !== "queued") continue;
      if (m.chain_depth > this.deps.mailMaxDepth) {
        const reason = `downgraded: chain too deep (cap ${this.deps.mailMaxDepth})`;
        this.deps.store.downgradeMailToNote(m.id, reason);
        this.resumeFromAnswer(m.id, `Declined: ${reason}`);
        continue;
      }
      if (!this.deps.spendGuard.allow()) return; // stays queued; the midnight resume tick pumps again
      const canonical = this.deps.registry.agentOf.get(m.to_agent);
      const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
      if (!canonical || !def) {
        this.deps.store.refuseMail(m.id, `unknown recipient "${m.to_agent}"`);
        this.resumeFromAnswer(m.id, `Refused: unknown recipient "${m.to_agent}"`);
        continue;
      }
      // Defense in depth: re-check the private wall against the stored provenance (send-time raced).
      if (def.manifest.visibility === "private" &&
          !isPrivateOrigin(this.deps.primaryChat, m.origin_channel, m.origin_chat_id)) {
        const reason = `${canonical} is private — origin not the private chat`;
        this.deps.store.refuseMail(m.id, reason);
        this.resumeFromAnswer(m.id, `Refused: ${reason}`);
        continue;
      }
      const dept = def.department;
      if (this.deps.planner && this.deps.registry.departments.get(dept)?.lead === canonical) {
        // Mail to a department lead → planned multi-node graph (async). Claim first so a re-entrant
        // pump pass cannot spawn a second goal for the same mail.
        if (this.deps.store.claimMailPlanning(m.id)) void this.spawnGraphFromMail(m, dept);
      } else {
        const goal = this.spawnFromMail(m, canonical, dept);
        void this.startGoal(goal);
      }
    }
  }

  /** The lead-mail graph path (spec §3). Async: the planner runs LLM calls. On success the mail is
   *  flipped to spawned; on planner failure it is refused (sender-visible), and the pump continues. */
  private async spawnGraphFromMail(m: MailRow, department: string): Promise<void> {
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    try {
      const goal = await this.deps.planner!.planFromMail(this, {
        department, title, request: m.body, channel: m.origin_channel, chatId: m.origin_chat_id,
      }, m);
      this.deps.store.markMailSpawned(m.id, goal.id);
      this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
    } catch (err) {
      const reason = `planning failed: ${(err as Error).message}`;
      this.deps.store.refuseMail(m.id, reason);
      // The ONLY refusal path that previously skipped this — an asker parked on this
      // request would otherwise stay awaiting-mail until the next daemon restart.
      this.resumeFromAnswer(m.id, `Refused: ${reason}`);
      this.pump();
    }
  }

  private spawnFromMail(m: MailRow, canonical: string, department: string): GoalRow {
    const lead = this.deps.registry.departments.get(department)?.lead ?? "hermes";
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    let goal!: GoalRow;
    this.deps.store.transaction(() => {
      goal = this.insertGoal({
        title, request: m.body, department, lead,
        origin: { channel: m.origin_channel, chatId: m.origin_chat_id },
        planSummary: `${MAIL_PREFIX}${m.id}`, chainDepth: m.chain_depth, spawnedByMail: m.id,
      });
      this.deps.store.insertNodes(goal.id, [{
        node_key: "task", type: "run", agent: canonical, critic: null,
        brief: `Requested by ${m.from_agent} via mail ${m.id}. Your result is automatically reported back to them.`,
        depends_on: [], max_rounds: 1,
      }]);
      this.deps.store.markMailSpawned(m.id, goal.id);
    });
    this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
    return goal;
  }

  /** The report REPLACES the origin-chat ping for mail-spawned goals (spec §5). */
  private mailReport(goal: GoalRow, ok: boolean, error: string | undefined, files: string[]): void {
    const src = this.deps.store.getMail(goal.spawned_by_mail!);
    if (!src) return;
    const refs = files.map((f) => `goals/${goal.goal_dir}/${f}`).join(", ");
    const body = ok
      ? `Done: ${goal.title}\nArtifacts: ${refs || "(none)"}`
      : `Failed: ${goal.title}\n${error ?? "unknown error"}`;
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: src.to_agent, to_agent: src.from_agent, kind: "report", body,
      goal_id: goal.id, origin_channel: goal.origin_channel, origin_chat_id: goal.origin_chat_id,
      chain_depth: goal.chain_depth, status: "unread", error: null,
      thread_id: src.thread_id ?? src.id, in_reply_to: src.id,
    });
    this.emit({ type: "mail.sent", id, from: src.to_agent, to: src.from_agent, kind: "report" });
    this.resumeFromAnswer(src.id, body);
  }

  /** Owner answers a pending user-ask (Mission Control POST or chat intercept): insert the
   *  answering report, then resume the parked asker via the shared path. Double-submit safe —
   *  answered-ness is derived from mailAnsweringRequest, the request's status never changes. */
  answerUserMail(mailId: string, text: string): { ok: true } | { ok: false; reason: string } {
    const m = this.deps.store.getMail(mailId);
    if (!m || m.kind !== "request" || m.to_agent !== "user" || m.status !== "awaiting-human")
      return { ok: false, reason: "not a pending question" };
    if (this.deps.store.mailAnsweringRequest(m.id)) return { ok: false, reason: "already answered" };
    if (!text.trim()) return { ok: false, reason: "empty answer" };
    const id = randomUUID();
    this.deps.store.insertMail({
      id, from_agent: "user", to_agent: m.from_agent, kind: "report", body: text,
      goal_id: null, origin_channel: m.origin_channel, origin_chat_id: m.origin_chat_id,
      chain_depth: m.chain_depth, status: "unread", error: null,
      thread_id: m.thread_id ?? m.id, in_reply_to: m.id,
    });
    this.emit({ type: "mail.sent", id, from: "user", to: m.from_agent, kind: "report" });
    this.resumeFromAnswer(m.id, text);
    return { ok: true };
  }

  /** Primary-chat "@agent <answer>" intercept core. Fires ONLY when that agent has a pending
   *  user-ask (oldest wins); returns the confirmation reply, or null → normal routing.
   *  Bare messages and unknown/idle @mentions are never intercepted. */
  answerFromChat(text: string): string | null {
    const m = /^@([\w-]+)\s+([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const agent = this.deps.registry.agentOf.get(m[1].toLowerCase());
    if (!agent) return null;
    const pending = this.deps.store.pendingUserAsksFrom(agent);
    if (!pending.length) return null;
    const res = this.answerUserMail(pending[0].id, m[2]);
    return res.ok ? `Answer sent to ${agent} — resuming.` : null; // lost race → fall through
  }

  /** Un-park a goal waiting on `requestId` by adding a continuation node carrying the answer.
   *  Idempotent: a no-op when no goal is parked on that request (already resumed / never parked). */
  private resumeFromAnswer(requestId: string, answerBody: string): void {
    const g = this.deps.store.goalAwaiting(requestId);
    if (!g) return;
    const req = this.deps.store.getMail(requestId);
    if (!req) return;
    const n = this.deps.store.listNodes(g.id).filter((x) => x.node_key.startsWith("resume_")).length + 1;
    const key = `resume_${n}`;
    const brief = `Earlier you asked ${req.to_agent}: "${req.body}"\n\nThey answered:\n${answerBody}\n\n` +
      `Continue and complete the task with this answer.`;
    this.deps.store.transaction(() => {
      this.deps.store.insertNodes(g.id, [{
        node_key: key, type: "run", agent: req.from_agent, critic: null, brief, depends_on: [], max_rounds: 1,
      }]);
      this.deps.store.clearAwaiting(g.id);
      this.deps.store.updateGoalStatus(g.id, "running");
    });
    this.emit({ type: "goal.status", goalId: g.id, status: "running" });
    this.pump();
  }

  private launch(goal: GoalRow, node: TaskNodeRow): void {
    this.runningNodes++;
    this.setNodeStatus(goal, node.node_key, "running", node.agent);
    const facade = goal.plan_summary.startsWith(FACADE_PREFIX);
    const sandbox = this.sandboxes.get(goal.id);
    const origin = { channel: goal.origin_channel, chatId: goal.origin_chat_id };
    const resolvePack = () => facade
      ? this.deps.resolveDeptFor(goal.plan_summary.slice(FACADE_PREFIX.length), origin, false, sandbox)
      : this.deps.resolveDeptFor(node.agent, origin, true, sandbox);
    runNode(this.deps.store.getGoal(goal.id)!, node, { ...this.deps, resolvePack })
      .then(() => this.setNodeStatus(goal, node.node_key, "done", node.agent))
      .catch(async (err: Error) => {
        // A node that parked its goal via ask_mail is already 'done'; a late run rejection must
        // not flip it to failed or fail the legitimately-parked goal.
        if (this.deps.store.listNodes(goal.id).find((x) => x.node_key === node.node_key)?.status === "done") return;
        this.setNodeStatus(goal, node.node_key, "failed", node.agent, err.message);
        await this.onNodeFailure(this.deps.store.getGoal(goal.id)!, node, err);
      })
      .finally(() => { this.runningNodes--; this.pump(); });
  }

  private async onNodeFailure(goal: GoalRow, node: TaskNodeRow, err: Error): Promise<void> {
    if (err instanceof SessionLimitError) {
      this.setGoalStatus(goal.id, "paused-user", err.message);
      return;
    }
    // Facades and mail-spawned goals are single-node/fixed graphs — never re-planned.
    const facade = goal.plan_summary.startsWith(FACADE_PREFIX) || goal.plan_summary.startsWith(MAIL_PREFIX);
    const cap = this.deps.replanCap ?? 2;
    if (facade || !this.deps.planner || goal.replans_used >= cap) {
      const msg = `node ${node.node_key} failed: ${err.message}${!facade && goal.replans_used >= cap ? ` (re-plans exhausted: ${cap})` : ""}`;
      this.setGoalStatus(goal.id, "failed", msg);
      this.deps.store.skipUnfinishedNodes(goal.id);
      await this.complete(goal, false, msg);
      return;
    }
    // lead-planned: re-plan (Task 7 provides Planner.replan)
    this.setGoalStatus(goal.id, "replanning");
    this.deps.store.bumpReplans(goal.id);
    try {
      await this.deps.planner.replan(this.deps.store.getGoal(goal.id)!, node, err.message);
      this.setGoalStatus(goal.id, "running");
      this.pump();
    } catch (planErr) {
      const msg = `re-planning failed: ${(planErr as Error).message}`;
      this.setGoalStatus(goal.id, "failed", msg);
      this.deps.store.skipUnfinishedNodes(goal.id);
      await this.complete(goal, false, msg);
    }
  }

  private async complete(goal: GoalRow, ok: boolean, error?: string): Promise<void> {
    const fresh = this.deps.store.getGoal(goal.id)!;
    const files = this.deps.store.listNodes(goal.id).filter((n) => n.artifact).map((n) => n.artifact!);
    // Mail-spawned goals report back to their sender instead of pinging the origin chat.
    if (fresh.spawned_by_mail) {
      this.mailReport(fresh, ok, error, files);
      return;
    }
    try {
      await this.deps.onComplete({ goal: fresh, ok, error, goalDirName: fresh.goal_dir ?? "", artifactFiles: files });
    } catch (err) {
      this.deps.log?.(`[${goal.slug}] onComplete failed: ${(err as Error).message}`);
    }
  }

  private findGoal(idOrSlug: string): GoalRow | undefined {
    return this.deps.store.getGoal(idOrSlug) ?? this.deps.store.getGoalBySlug(idOrSlug);
  }

  pauseGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.status !== "running" && g.status !== "replanning") return `Goal ${g.slug} is ${g.status} — nothing to pause.`;
    this.setGoalStatus(g.id, "paused-user");
    return `Goal ${g.slug} paused (running nodes finish; nothing new starts). /resume ${g.slug} to continue.`;
  }

  resumeGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.status !== "paused-user" && g.status !== "paused-budget") return `Goal ${g.slug} is ${g.status} — nothing to resume.`;
    this.setGoalStatus(g.id, "running");
    this.pump();
    return `Goal ${g.slug} resumed.`;
  }

  abandonGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (["done", "failed", "abandoned"].includes(g.status)) return `Goal ${g.slug} is already ${g.status}.`;
    this.setGoalStatus(g.id, "abandoned");
    this.deps.store.skipUnfinishedNodes(g.id);
    // A mail-spawned goal must still answer its request — otherwise the request stays
    // 'spawned' forever and a parked asker never resumes (boot reconcile has no branch for it).
    if (g.spawned_by_mail) {
      const files = this.deps.store.listNodes(g.id).filter((n) => n.artifact).map((n) => n.artifact!);
      this.mailReport(this.deps.store.getGoal(g.id)!, false, "abandoned by user", files);
    }
    return `Goal ${g.slug} abandoned; unfinished nodes skipped.`;
  }

  /** Startup only — reset orphaned running nodes (they re-run) and pump unfinished goals. */
  resumeUnfinished(): number {
    this.deps.store.reconcilePlanningMail();
    // Parked (awaiting-mail) goals whose answer already landed while we were down → resume now.
    for (const g of this.deps.store.awaitingMailGoals()) {
      if (!g.awaiting_mail) continue;
      const answer = this.deps.store.mailAnsweringRequest(g.awaiting_mail);
      if (answer) { this.resumeFromAnswer(g.awaiting_mail, answer.body); continue; }
      const req = this.deps.store.getMail(g.awaiting_mail);
      if (req?.status === "refused") this.resumeFromAnswer(g.awaiting_mail, `Refused: ${req.error ?? "unknown"}`);
      else if (req?.kind === "note") this.resumeFromAnswer(g.awaiting_mail, `Declined: ${req.error ?? "chain too deep"}`);
    }
    this.deps.store.resetRunningNodes();
    const goals = this.deps.store.unfinishedGoals();
    for (const g of goals) if (g.status === "replanning" || g.status === "planning") this.setGoalStatus(g.id, "running");
    this.pump();
    return goals.length;
  }

  resumeBudgetPaused(): number {
    if (!this.deps.spendGuard.allow()) return 0;
    const paused = this.deps.store.pausedBudgetGoals();
    for (const g of paused) this.setGoalStatus(g.id, "running");
    if (paused.length) this.pump();
    return paused.length;
  }

  async planGoal(params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow> {
    if (!this.deps.planner) throw new Error("planner not configured");
    return this.deps.planner.plan(this, params);   // Task 7 implements; engine exposes insertGoalPlanned below
  }

  /** Used by the Planner (Task 7) to persist a validated plan and start it. */
  startPlannedGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; summary: string;
    nodes: import("../store/db.js").NewTaskNode[]; projectDir?: string; needsWorkspace: string;
    spawnedByMail?: string; chainDepth?: number;
  }): GoalRow {
    const goal = this.insertGoal({
      title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, projectDir: p.projectDir, planSummary: p.summary,
      chainDepth: p.chainDepth, spawnedByMail: p.spawnedByMail,
    });
    this.deps.store.insertNodes(goal.id, p.nodes);
    void this.startGoal(goal);
    return goal;
  }
}
