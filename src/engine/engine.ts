// src/engine/engine.ts — the journaled GoalEngine. Public API preserved; internals are
// fold(journal) → decide() → dispatch commands → append events → re-fold. No in-memory
// scheduler state survives a crash because none is load-bearing: "running" is derived
// from dangling attempt.started events, and recovery (resumeUnfinished) is the same
// fold+decide path as normal operation.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Store, GoalRow, MailRow, NewTaskNode, TaskNodeRow } from "../store/db.js";
import { isPrivateOrigin } from "../agents/direct.js";
import { slugify, type VaultWriter } from "../vault/writer.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { AiosEvent } from "../events.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import type { Playbook } from "./playbook.js";
import { compilePlaybook, toNewTaskNodes, isUnsandboxedWrite, type GraphNodeSpec } from "./compile.js";
import { assertInplaceTarget, resolveReal } from "../code/paths.js";
import { indexMailThread } from "../memory/indexer.js";
import type { SpendGuard } from "./budget.js";
import {
  appendEvents, readJournal, pausedStatus,
  type EventInput, type NodeSpec, type GoalCreatedPayload, type ReplanRecordedPayload,
} from "./journal.js";
import { reduce, type GoalState } from "./reduce.js";
import { decide, type Caps, type Command } from "./decide.js";
import { AbortRegistry, runAttempt } from "./workers.js";

const FACADE_PREFIX = "playbook:";

/** Minimum age of a session pause before the heartbeat probes it (failure-class spec §A4). */
const SESSION_PROBE_MIN_AGE_MS = 30 * 60_000;
/** plan_summary marker for mail-spawned goals (single node, never re-planned). */
export const MAIL_PREFIX = "mail:";

export interface ReplanPatch { replaced: GraphNodeSpec[]; added: GraphNodeSpec[] }

export interface Planner {
  plan(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow>;
  planFromMail(engine: GoalEngine, params: { department: string; title: string; request: string; channel: string; chatId: string }, mail: MailRow): Promise<GoalRow>;
  /** Validate and RETURN the patch; the engine records it as replan.recorded. */
  replan(goal: GoalRow, failed: TaskNodeRow, error: string): Promise<ReplanPatch>;
}

export interface GoalOutcome {
  goal: GoalRow; ok: boolean; error?: string; goalDirName: string; artifactFiles: string[];
}

export interface GoalEngineDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  registry: LoadedRegistry;
  playbooks: Map<string, Playbook>;
  wallTimeMs: number;
  maxConcurrentNodes: number;
  spendGuard: SpendGuard;
  onComplete: (o: GoalOutcome) => Promise<void>;
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
  /** Per-attempt deadline base (run nodes; loop/verify get 2x). Default 15 min. */
  nodeTimeoutMs?: number;
  /** Queue an always-supervised permission.grant when a park hits an allowlist wall. */
  proposeGrant?: (role: string, tool: string) => Promise<void>;
  /** Visible-retry cap per node (spec §7). Default 2. */
  maxAttempts?: number;
  /** Backoff delay for in-place API retries — injected so tests never wait. */
  sleep?: (ms: number) => Promise<void>;
}

const toSpec = (n: NewTaskNode): NodeSpec => ({
  key: n.node_key, kind: n.type, agent: n.agent, critic: n.critic,
  brief: n.brief, dependsOn: n.depends_on, maxRounds: n.max_rounds,
});
const graphToSpec = (g: GraphNodeSpec): NodeSpec => toSpec(toNewTaskNodes([g])[0]);

export class GoalEngine {
  private abortRegistry = new AbortRegistry();
  private inFlight = new Set<string>();
  private ticking = false;
  private tickAgain = false;

  constructor(private deps: GoalEngineDeps) {}

  // ---------- plumbing ----------

  private emit(e: AiosEvent): void { this.deps.onEvent?.(e); }

  /** Append + surface matching bus events (goal.status / node.status) for SSE/UI. */
  private journal(goalId: string, events: EventInput[], also?: () => void): boolean {
    const appended = appendEvents(this.deps.store, goalId, events, { also });
    if (!appended) return false;
    const agentOf = (node: string) =>
      this.deps.store.listNodes(goalId).find((n) => n.node_key === node)?.agent ?? "";
    for (const ev of appended) {
      const p = ev.payload as Record<string, unknown>;
      switch (ev.type) {
        case "goal.paused":
          this.emit({ type: "goal.status", goalId, status: pausedStatus(p.reason as string), error: p.error as string | undefined });
          break;
        case "goal.resumed": case "ask.resumed":
          this.emit({ type: "goal.status", goalId, status: "running" }); break;
        case "ask.parked":
          this.emit({ type: "goal.status", goalId, status: "awaiting-mail" }); break;
        case "goal.completed":
          this.emit({ type: "goal.status", goalId, status: "done" }); break;
        case "goal.failed":
          this.emit({ type: "goal.status", goalId, status: "failed", error: String(p.error ?? "") }); break;
        case "goal.abandoned":
          this.emit({ type: "goal.status", goalId, status: "abandoned" }); break;
        case "node.completed":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "done", agent: agentOf(String(p.node)) }); break;
        case "node.failed":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "failed", agent: agentOf(String(p.node)), error: String(p.error ?? "") }); break;
        case "node.skipped":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "skipped", agent: agentOf(String(p.node)) }); break;
        case "review.requested":
          this.emit({ type: "node.status", goalId, nodeKey: String(p.node), status: "needs-review", agent: agentOf(String(p.node)) }); break;
        default: break; // attempt.started emits node.status from the worker; the rest are internal
      }
    }
    return true;
  }

  private fold(goalId: string): GoalState {
    return reduce(readJournal(this.deps.store, goalId));
  }

  private caps(): Caps {
    return {
      maxConcurrent: this.deps.maxConcurrentNodes,
      budgetAllowed: this.deps.spendGuard.allow(),
      wallTimeMs: this.deps.wallTimeMs,
      replanCap: this.deps.replanCap ?? 2,
      plannerAvailable: !!this.deps.planner,
      maxAttempts: this.deps.maxAttempts ?? 2,
    };
  }

  // ---------- the loop ----------

  /** Legacy name kept — external callers (mailbox onQueued, moderator, tests) pump. */
  pump(): void { this.tick(); }

  tick(): void {
    if (this.ticking) { this.tickAgain = true; return; }
    this.ticking = true;
    try {
      let rounds = 0;
      do {
        this.tickAgain = false;
        this.sweepMail();
        this.enforceBudgetAbort();
        this.dispatch(decide(this.states(), this.caps(), Date.now()));
      } while (this.tickAgain && ++rounds < 10);
    } finally {
      this.ticking = false;
    }
  }

  private states(): GoalState[] {
    const rows = [...this.deps.store.unfinishedGoals(), ...this.deps.store.awaitingMailGoals()];
    return rows.map((g) => this.fold(g.id)).filter((s) => s.created !== null);
  }

  /** Spec §8: crossing the daily cap aborts everything in flight — attempts land as
   *  aborted, then decide() parks the goals. Never blows through the cap mid-node. */
  private enforceBudgetAbort(): void {
    if (this.abortRegistry.size() === 0 || this.deps.spendGuard.allow()) return;
    this.abortRegistry.abortAll("budget");
  }

  private dispatch(commands: Command[]): void {
    for (const c of commands) {
      switch (c.cmd) {
        case "StartAttempt": {
          const key = `run:${c.goalId}:${c.node}:${c.attempt}`;
          if (this.inFlight.has(key)) break;
          this.inFlight.add(key);
          void this.worker(c.goalId, c.node, c.attempt)
            .finally(() => { this.inFlight.delete(key); this.tick(); });
          break;
        }
        case "AbortAttempt":
          this.abortRegistry.abort(this.abortRegistry.key(c.goalId, c.node, c.attempt), "timeout");
          break;
        case "FailNode":
          this.journal(c.goalId, [{ type: "node.failed", payload: { node: c.node, error: c.error } }]);
          this.tickAgain = true;
          break;
        case "RequestReplan": {
          const key = `replan:${c.goalId}`;
          if (this.inFlight.has(key)) break;
          this.inFlight.add(key);
          void this.replan(c.goalId, c.node, c.error)
            .finally(() => { this.inFlight.delete(key); this.tick(); });
          break;
        }
        case "PrepareWorkspace": {
          const key = `ws:${c.goalId}`;
          if (this.inFlight.has(key)) break;
          this.inFlight.add(key);
          void this.prepareWorkspace(c.goalId)
            .finally(() => { this.inFlight.delete(key); this.tick(); });
          break;
        }
        case "ParkForBudget": {
          this.journal(c.goalId, [{ type: "goal.paused", payload: { reason: "budget" } }]);
          const date = new Date().toISOString().slice(0, 10);
          const kv = `budget:pinged:${date}`;
          if (!this.deps.store.kvGet(kv)) {
            this.deps.store.kvSet(kv, "1");
            this.deps.pingBudgetPaused?.("Daily budget reached — paused background goals; they resume tomorrow.");
          }
          break;
        }
        case "CompleteGoal":
          if (this.journal(c.goalId, [{ type: "goal.completed", payload: {} }])) {
            void this.complete(this.deps.store.getGoal(c.goalId)!, true);
          }
          break;
        case "FailGoal":
          this.failGoal(c.goalId, c.error);
          break;
      }
    }
  }

  private failGoal(goalId: string, error: string): void {
    const state = this.fold(goalId);
    if (state.phase !== "running" && state.phase !== "awaiting-mail") return; // already terminal
    for (const n of state.nodes.values()) {
      if (n.runningAttempt) {
        this.abortRegistry.abort(this.abortRegistry.key(goalId, n.spec.key, n.runningAttempt.attempt), "abandoned");
      }
    }
    const skips: EventInput[] = [...state.nodes.values()]
      .filter((n) => n.status === "pending" && !n.runningAttempt)
      .map((n) => ({ type: "node.skipped" as const, payload: { node: n.spec.key } }));
    this.journal(goalId, [...skips, { type: "goal.failed", payload: { error } }]);
    void this.complete(this.deps.store.getGoal(goalId)!, false, error);
  }

  private async worker(goalId: string, nodeKey: string, attempt: number): Promise<void> {
    const goal = this.deps.store.getGoal(goalId);
    if (!goal) return;
    const state = this.fold(goalId);
    const spec = state.nodes.get(nodeKey)?.spec;
    if (!spec || !state.created) return;
    const sandbox = state.workspace?.taskDir && state.workspace.mode
      ? { taskDir: state.workspace.taskDir, mode: state.workspace.mode } : undefined;
    try {
      // resolveAgent (inside deps.run) owns capability/dept resolution per node agent —
      // origin/workspace/idempotencyKey travel through RunOptions (org-model cutover).
      const res = await runAttempt(goal, spec, attempt, {
        store: this.deps.store, vault: this.deps.vault, run: this.deps.run,
        log: this.deps.log, onEvent: this.deps.onEvent,
        workspace: sandbox,
        registry: this.abortRegistry,
        nodeTimeoutMs: this.deps.nodeTimeoutMs ?? 900_000,
        sleep: this.deps.sleep,
        proposeGrant: this.deps.proposeGrant,
      });
      if (res.sessionLimit && this.fold(goalId).phase === "running") {
        this.journal(goalId, [{ type: "goal.paused", payload: { reason: "session", error: "Agent hit session limit — re-run after quota resets" } }]);
      }
      if (res.apiUnreachable && this.fold(goalId).phase === "running") {
        // Infrastructure, not the agent. Pause with the verbatim error; the heartbeat resumes it.
        const lastError = this.deps.store.listNodes(goalId).find((n) => n.node_key === nodeKey)?.error;
        this.journal(goalId, [{ type: "goal.paused", payload: { reason: "api", error: lastError ?? "API unreachable" } }]);
      }
    } catch (err) {
      this.deps.log?.(`worker ${goalId}/${nodeKey}#${attempt}: ${(err as Error).message}`);
    }
  }

  private async replan(goalId: string, nodeKey: string, error: string): Promise<void> {
    const goal = this.deps.store.getGoal(goalId);
    const failedRow = this.deps.store.listNodes(goalId).find((n) => n.node_key === nodeKey);
    if (!goal || !failedRow) return;
    // Cosmetic projection touch only — the journal never records "replanning"; a crash
    // here re-decides and retries the replan (uncounted — accepted delta #1).
    this.deps.store.updateGoalStatus(goalId, "replanning");
    this.emit({ type: "goal.status", goalId, status: "replanning" });
    try {
      const patch = await this.deps.planner!.replan(goal, failedRow, error);
      const payload: ReplanRecordedPayload = {
        kind: "replan", forNode: nodeKey,
        replaced: patch.replaced.map(graphToSpec), added: patch.added.map(graphToSpec),
        retargets: [], reason: error,
      };
      this.journal(goalId, [{ type: "replan.recorded", payload: payload as unknown as Record<string, unknown> }]);
      this.deps.store.updateGoalStatus(goalId, "running");
      this.emit({ type: "goal.status", goalId, status: "running" });
    } catch (planErr) {
      this.deps.store.updateGoalStatus(goalId, "running"); // undo cosmetic before terminal event
      this.failGoal(goalId, `re-planning failed: ${(planErr as Error).message}`);
    }
  }

  /** Workspace eligibility (spec 2026-07-07-workspace-mail-goals) — port of the old
   *  mailWorkspaceEligible; fail-closed when the source mail row is missing. */
  private mailWorkspaceEligible(state: GoalState): boolean {
    const c = state.created!;
    if (!c.spawnedByMail) return true;
    if (c.planSummary.startsWith(MAIL_PREFIX)) return false;
    if (c.department !== "engineering") return false;
    return this.deps.store.getMail(c.spawnedByMail)?.from_agent === "user";
  }

  private async prepareWorkspace(goalId: string): Promise<void> {
    const state = this.fold(goalId);
    if (!state.created || !state.workspacePending) return;
    const goal = this.deps.store.getGoal(goalId)!;
    const eligible = this.mailWorkspaceEligible(state);
    try {
      if (!eligible) {
        // Hard-strip any planner-passed dir on ineligible mail-goals — the wall holds
        // regardless of planner behavior (spec 2026-07-07).
        this.journal(goalId, [{ type: "workspace.prepared", payload: { taskDir: null, mode: null, stripped: Boolean(goal.project_dir) } }]);
        return;
      }
      const pb = state.created.planSummary.startsWith(FACADE_PREFIX)
        ? this.deps.playbooks.get(state.created.planSummary.slice(FACADE_PREFIX.length))
        : undefined;
      const sandbox = await this.deps.prepareSandbox?.(goal, { playbook: pb });
      const effectiveDir = sandbox?.taskDir ?? goal.project_dir;
      if (effectiveDir) mkdirSync(effectiveDir, { recursive: true });
      this.journal(goalId, [{ type: "workspace.prepared", payload: { taskDir: sandbox?.taskDir ?? null, mode: sandbox?.mode ?? null } }]);
    } catch (err) {
      // A mail-goal whose sandbox setup failed must not advertise a workspace that never
      // existed (port of the old strip-on-failure).
      if (goal.spawned_by_mail && goal.project_dir) this.deps.store.setGoalProjectDir(goalId, null);
      this.journal(goalId, [{ type: "workspace.failed", payload: { error: (err as Error).message } }]);
      this.tickAgain = true; // decide() converts workspaceError into FailGoal
    }
  }

  // ---------- creation (public API preserved) ----------

  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({
      name: p.name, description: p.description, pillar: this.deps.registry.ownerOfPlaybook.get(p.name),
    }));
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
    // Fall back to the org's own coordinator, not to this install's names. A playbook no
    // department claims is the normal case for a provisioned org — onboarding writes every
    // department with `playbooks: []` — and "operations"/"neo" exist in exactly one org on
    // earth, so the old literals produced goals owned by a department and a lead that were not
    // there. On this install the coordinator IS neo in operations, so nothing changes here.
    const reg = this.deps.registry;
    const dept = reg.ownerOfPlaybook.get(params.playbook)
      ?? reg.agents.get(reg.coordinator)?.department
      ?? "operations";
    const lead = reg.departments.get(dept)?.lead ?? reg.coordinator ?? "neo";
    return this.createGoal({
      title: params.title, request: params.request, department: dept, lead,
      origin: { channel: params.channel, chatId: params.chatId },
      projectDir: params.projectDir ?? null, planSummary: `${FACADE_PREFIX}${params.playbook}`,
      chainDepth: 0, spawnedByMail: null,
      nodes: toNewTaskNodes(compilePlaybook(pb)).map(toSpec),
    });
  }

  /** Used by the lead planner to persist a validated plan and start it.
   *  Note: `needsWorkspace` is advisory only — `projectDir` is the sole carrier of workspace
   *  intent here; allocation mode is derived in prepareSandbox from project_dir presence. */
  startPlannedGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; summary: string;
    nodes: NewTaskNode[]; projectDir?: string; needsWorkspace: string;
    spawnedByMail?: string; chainDepth?: number;
  }): GoalRow {
    return this.createGoal({
      title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, projectDir: p.projectDir ?? null, planSummary: p.summary,
      chainDepth: p.chainDepth ?? 0, spawnedByMail: p.spawnedByMail ?? null,
      nodes: p.nodes.map(toSpec),
      also: p.spawnedByMail
        ? (goalId) => this.deps.store.markMailSpawned(p.spawnedByMail!, goalId)
        : undefined,
    });
  }

  /** Shared creation: goal.md, then goal.created + plan.recorded in ONE atomic append
   *  (with any mail-spawned flip inside the same transaction). */
  private createGoal(p: {
    title: string; request: string; department: string; lead: string;
    origin: { channel: string; chatId: string }; projectDir: string | null;
    planSummary: string; chainDepth: number; spawnedByMail: string | null;
    nodes: NodeSpec[]; also?: (goalId: string) => void;
  }): GoalRow {
    const id = randomUUID();
    const slug = slugify(p.title);
    const goalDir = this.deps.vault.goalDirName(slug);
    this.deps.vault.writeGoalArtifact(goalDir, "goal.md",
      `# ${p.title}\n\n- department: ${p.department}\n- lead: ${p.lead}\n- status: running\n\n## Request\n\n${p.request}\n\n## Plan\n\n${p.planSummary}`,
      { goal: id, department: p.department });
    const created: GoalCreatedPayload = {
      slug, title: p.title, request: p.request, department: p.department, lead: p.lead,
      origin: p.origin, chainDepth: p.chainDepth, spawnedByMail: p.spawnedByMail,
      planSummary: p.planSummary, goalDir, projectDir: p.projectDir,
    };
    this.journal(id, [
      { type: "goal.created", payload: created as unknown as Record<string, unknown> },
      { type: "plan.recorded", payload: { summary: p.planSummary, needsWorkspace: "auto", nodes: p.nodes } as unknown as Record<string, unknown> },
    ], p.also ? () => p.also!(id) : undefined);
    this.emit({ type: "goal.created", goalId: id, title: p.title, department: p.department });
    this.tick();
    return this.deps.store.getGoal(id)!;
  }

  async planGoal(params: { department: string; title: string; request: string; channel: string; chatId: string }): Promise<GoalRow> {
    if (!this.deps.planner) throw new Error("planner not configured");
    return this.deps.planner.plan(this, params);
  }

  // ---------- pause / resume / abandon ----------

  private findGoal(idOrSlug: string): GoalRow | undefined {
    return this.deps.store.getGoal(idOrSlug) ?? this.deps.store.getGoalBySlug(idOrSlug);
  }

  pauseGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    if (g.status !== "running" && g.status !== "replanning") return `Goal ${g.slug} is ${g.status} — nothing to pause.`;
    this.journal(g.id, [{ type: "goal.paused", payload: { reason: "user" } }]);
    return `Goal ${g.slug} paused (running nodes finish; nothing new starts). /resume ${g.slug} to continue.`;
  }

  resumeGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    if (g.status !== "paused-user" && g.status !== "paused-budget" && g.status !== "paused-api") return `Goal ${g.slug} is ${g.status} — nothing to resume.`;
    this.journal(g.id, [{ type: "goal.resumed", payload: { by: "user" } }]);
    this.tick();
    return `Goal ${g.slug} resumed.`;
  }

  abandonGoal(idOrSlug: string): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — mark it done by hand if it lingers.`;
    if (["done", "abandoned"].includes(g.status)) return `Goal ${g.slug} is already ${g.status}.`;
    const state = this.fold(g.id);
    for (const n of state.nodes.values()) {
      if (n.runningAttempt) this.abortRegistry.abort(this.abortRegistry.key(g.id, n.spec.key, n.runningAttempt.attempt), "abandoned");
    }
    const skips: EventInput[] = [...state.nodes.values()]
      .filter((n) => n.status === "pending" && !n.runningAttempt)
      .map((n) => ({ type: "node.skipped" as const, payload: { node: n.spec.key } }));
    this.journal(g.id, [...skips, { type: "goal.abandoned", payload: { by: "user" } }]);
    // A mail-spawned goal must still answer its request — otherwise the request stays
    // 'spawned' forever and a parked asker never resumes.
    if (g.spawned_by_mail) {
      const files = this.deps.store.listNodes(g.id).filter((n) => n.artifact).map((n) => n.artifact!);
      this.mailReport(this.deps.store.getGoal(g.id)!, false, "abandoned by user", files);
    }
    return `Goal ${g.slug} abandoned; unfinished nodes skipped.`;
  }

  /** Resurrection (goal-resurrection spec §2): reopen a failed or abandoned goal at its
   *  frontier. One event; the fold rewinds node state and the projection follows. */
  reopenGoal(idOrSlug: string, opts: { by: string; guidance?: string }): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    if (g.status !== "failed" && g.status !== "abandoned") {
      return `Goal ${g.slug} is ${g.status} — only failed or abandoned goals can be reopened.`;
    }
    this.journal(g.id, [{ type: "goal.reopened", payload: {
      by: opts.by, ...(opts.guidance ? { guidance: opts.guidance } : {}),
    } }]);
    this.tick();
    return `Goal ${g.slug} reopened; failed and skipped nodes will retry.`;
  }

  /** Apply a human verdict to a needs-review node (verification-hardening §4).
   *  accept → completes with a waiver in the artifact frontmatter; retry → one
   *  human-granted attempt with guidance as producer feedback; abandon → node fails
   *  into the normal onNodeFailure path.
   *
   *  `accept` is a turnstile, not a rubber stamp. Two machine-checkable signals mean the
   *  deliverable is known-absent rather than merely imperfect, and both were observed
   *  shipping empty goals as "done" (2026-08): a runner report of `passed: false` whose
   *  summary literally read "the central deliverable is absent", and an unreadable
   *  lastArtifactRef, which used to complete the node with the string "(missing artifact
   *  x.md)" AS the deliverable. Either refuses unless the caller passes `force`, which is
   *  then recorded in the artifact's frontmatter — an override stays queryable, never silent. */
  resolveReview(idOrSlug: string, nodeKey: string, verdict: "accept" | "retry" | "abandon",
    opts: { by: string; guidance?: string; force?: boolean }): string {
    const g = this.findGoal(idOrSlug);
    if (!g) return `No goal "${idOrSlug}".`;
    if (g.legacy) return `Goal ${g.slug} is a frozen legacy goal — read-only.`;
    const state = this.fold(g.id);
    const n = state.nodes.get(nodeKey);
    if (!n || n.status !== "needs-review") return `Node ${nodeKey} of ${g.slug} is not awaiting review.`;
    const resolved: EventInput = { type: "review.resolved", payload: {
      node: nodeKey, verdict, by: opts.by, ...(opts.guidance ? { guidance: opts.guidance } : {}),
      ...(opts.force ? { forced: true } : {}),
    } };
    if (verdict === "accept") {
      // Waiver is recorded in the FINAL artifact's frontmatter — "done with waiver"
      // is queryable, never silent (spec §4).
      const src = n.lastArtifactRef ? this.deps.vault.readGoalArtifact(g.goal_dir!, n.lastArtifactRef) : undefined;
      const failing = n.lastReport && !n.lastReport.passed ? n.lastReport : undefined;
      if (!opts.force) {
        if (failing) {
          return `Refused: ${nodeKey} of ${g.slug} last reported FAILING verification — accepting it would mark a known-broken deliverable done.\n`
            + `  ${failing.summary}\n`
            + failing.failures.slice(0, 5).map((f) => `  - ${f}`).join("\n")
            + `\nRetry with guidance, abandon the node, or re-send accept with force to waive verification explicitly.`;
        }
        if (src === undefined) {
          return `Refused: ${nodeKey} of ${g.slug} has no readable artifact (${n.lastArtifactRef ?? "none recorded"}) — there is nothing to accept.\n`
            + `Retry the node, or re-send accept with force to complete it with a placeholder body.`;
        }
      }
      const body = src ? src.replace(/^---\n[\s\S]*?\n---\n\n?/, "") : `(missing artifact ${n.lastArtifactRef ?? "?"})`;
      const file = `${nodeKey}.md`;
      this.deps.vault.writeGoalArtifact(g.goal_dir!, file, body, {
        goal: g.id, node: nodeKey, role: n.spec.agent,
        "approved-with-waiver": true,
        objections: (n.reviewObjections ?? []).join("; "),
        "waived-by": opts.by,
        ...(failing ? { "waived-failing-verification": true, "verification-summary": failing.summary } : {}),
        ...(src === undefined ? { "waived-missing-artifact": n.lastArtifactRef ?? "none recorded" } : {}),
      });
      this.journal(g.id, [resolved,
        { type: "node.completed", payload: { node: nodeKey, artifactRef: file, roundsUsed: n.currentRound } }]);
    } else if (verdict === "abandon") {
      this.journal(g.id, [resolved,
        { type: "node.failed", payload: { node: nodeKey, error: "review: abandoned by user" } }]);
    } else {
      this.journal(g.id, [resolved]);
    }
    this.tick();
    return `Node ${nodeKey} of ${g.slug}: ${verdict}.`;
  }

  resumeBudgetPaused(): number {
    if (!this.deps.spendGuard.allow()) return 0;
    const paused = this.deps.store.pausedBudgetGoals();
    for (const g of paused) this.journal(g.id, [{ type: "goal.resumed", payload: { by: "budget-reset" } }]);
    if (paused.length) this.tick();
    return paused.length;
  }

  /** The API came back — resume goals parked by an outage. Mirrors resumeBudgetPaused. */
  resumeApiPaused(): number {
    const paused = this.deps.store.pausedApiGoals();
    for (const g of paused) this.journal(g.id, [{ type: "goal.resumed", payload: { by: "api-recovered" } }]);
    if (paused.length) this.tick();
    return paused.length;
  }

  /** Session quota may have reset — probe goals parked on the limit, at most every 30 min.
   *  A still-limited probe re-pauses uncounted, so the loop costs one spawn per window. */
  resumeSessionPaused(now: () => number = Date.now): number {
    const cutoff = now() - SESSION_PROBE_MIN_AGE_MS;
    const due = this.deps.store.pausedSessionGoals()
      .filter((g) => new Date(g.updated_at).getTime() <= cutoff);
    for (const g of due) this.journal(g.id, [{ type: "goal.resumed", payload: { by: "session-probe" } }]);
    if (due.length) this.tick();
    return due.length;
  }

  // ---------- completion ----------

  private async complete(goal: GoalRow, ok: boolean, error?: string): Promise<void> {
    const fresh = this.deps.store.getGoal(goal.id)!;
    const files = this.deps.store.listNodes(goal.id).filter((n) => n.artifact).map((n) => n.artifact!);
    if (fresh.spawned_by_mail) {
      this.mailReport(fresh, ok, error, files); // report REPLACES the origin-chat ping (spec §5)
      return;
    }
    try {
      await this.deps.onComplete({ goal: fresh, ok, error, goalDirName: fresh.goal_dir ?? "", artifactFiles: files });
    } catch (err) {
      this.deps.log?.(`[${goal.slug}] onComplete failed: ${(err as Error).message}`);
    }
  }

  // ---------- mail integration (journal-backed ports of the old engine paths) ----------

  /** Convert queued request mail into goals (spec §4). FIFO; fail-soft per item. */
  private sweepMail(): void {
    if (this.deps.mailDisabled) return; // kill-switch: queue drains on re-enable
    for (const m of this.deps.store.queuedRequests()) {
      if (this.deps.store.getMail(m.id)?.status !== "queued") continue; // stale snapshot re-check
      if (m.chain_depth > this.deps.mailMaxDepth) {
        const reason = `downgraded: chain too deep (cap ${this.deps.mailMaxDepth})`;
        this.deps.store.downgradeMailToNote(m.id, reason);
        this.resumeFromAnswer(m.id, `Declined: ${reason}`);
        continue;
      }
      if (!this.deps.spendGuard.allow()) continue; // stays queued; keep scanning for downgrades
      const canonical = this.deps.registry.agentOf.get(m.to_agent);
      const def = canonical ? this.deps.registry.agents.get(canonical) : undefined;
      if (!canonical || !def) {
        this.deps.store.refuseMail(m.id, `unknown recipient "${m.to_agent}"`);
        this.resumeFromAnswer(m.id, `Refused: unknown recipient "${m.to_agent}"`);
        this.reindexMailThread(m);
        continue;
      }
      if (def.manifest.visibility === "private" &&
          !isPrivateOrigin(this.deps.primaryChat, m.origin_channel, m.origin_chat_id)) {
        const reason = `${canonical} is private — origin not the private chat`;
        this.deps.store.refuseMail(m.id, reason);
        this.resumeFromAnswer(m.id, `Refused: ${reason}`);
        this.reindexMailThread(m);
        continue;
      }
      const dept = def.department;
      if (this.deps.planner && this.deps.registry.departments.get(dept)?.lead === canonical) {
        // Lead mail → planned graph (async). Claim first so a re-entrant tick can't
        // spawn a second goal for the same mail.
        if (this.deps.store.claimMailPlanning(m.id)) void this.spawnGraphFromMail(m, dept);
      } else {
        this.spawnFromMail(m, canonical, dept);
      }
    }
  }

  private async spawnGraphFromMail(m: MailRow, department: string): Promise<void> {
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    try {
      const goal = await this.deps.planner!.planFromMail(this, {
        department, title, request: m.body, channel: m.origin_channel, chatId: m.origin_chat_id,
      }, m);
      // markMailSpawned already happened atomically inside startPlannedGoal's append.
      this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
    } catch (err) {
      const reason = `planning failed: ${(err as Error).message}`;
      this.deps.store.refuseMail(m.id, reason);
      this.resumeFromAnswer(m.id, `Refused: ${reason}`);
      this.reindexMailThread(m);
      this.tick();
    }
  }

  private spawnFromMail(m: MailRow, canonical: string, department: string): void {
    const lead = this.deps.registry.departments.get(department)?.lead ?? "neo";
    const title = (m.body.split("\n")[0] ?? "").slice(0, 80) || `mail from ${m.from_agent}`;
    const goal = this.createGoal({
      title, request: m.body, department, lead,
      origin: { channel: m.origin_channel, chatId: m.origin_chat_id },
      projectDir: null, planSummary: `${MAIL_PREFIX}${m.id}`,
      chainDepth: m.chain_depth, spawnedByMail: m.id,
      nodes: [{
        key: "task", kind: "run", agent: canonical, critic: null,
        brief: `Requested by ${m.from_agent} via mail ${m.id}. Your result is automatically reported back to them.`,
        dependsOn: [], maxRounds: 1,
      }],
      also: (goalId) => this.deps.store.markMailSpawned(m.id, goalId),
    });
    this.emit({ type: "mail.spawned", mailId: m.id, goalId: goal.id });
  }

  /** Recall re-indexing after a sweep-time refusal — best-effort, never breaks the sweep. */
  private reindexMailThread(m: MailRow): void {
    try { indexMailThread(this.deps.store, this.deps.registry, m.thread_id ?? m.id); }
    catch { /* best-effort */ }
  }

  /** The report REPLACES the origin-chat ping for mail-spawned goals (spec §5). */
  private mailReport(goal: GoalRow, ok: boolean, error: string | undefined, files: string[]): void {
    const src = this.deps.store.getMail(goal.spawned_by_mail!);
    if (!src) return;
    const refs = files.map((f) => `goals/${goal.goal_dir}/${f}`).join(", ");
    const ws = goal.project_dir ? `\nWorkspace: ${goal.project_dir}` : "";
    const body = ok
      ? `Done: ${goal.title}\nArtifacts: ${refs || "(none)"}${ws}`
      : `Failed: ${goal.title}\n${error ?? "unknown error"}${ws}`;
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

  /** Mailbox hook: journal an ask_mail park. Called INSIDE the mailbox's transaction —
   *  appendEvents joins it, so the mail row and the park are atomic. */
  parkFromAsk(goalId: string, nodeKey: string | null, mailId: string): void {
    this.journal(goalId, [{ type: "ask.parked", payload: { node: nodeKey, mailId } }]);
  }

  /** Owner answers a pending user-ask. Double-submit safe — answered-ness derives from
   *  mailAnsweringRequest; the request's status never changes. */
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

  /** Primary-chat "@agent <answer>" intercept — fires ONLY on a pending user-ask. */
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

  /** Un-park the goal waiting on `requestId`: ask.resumed + a continuation node via the
   *  replan.recorded mechanism (kind "resume" — never counts against the replan cap).
   *  The continuation depends on the asking node; dependents are repointed (M4 semantics). */
  private resumeFromAnswer(requestId: string, answerBody: string): void {
    const g = this.deps.store.goalAwaiting(requestId);
    if (!g) return;
    const req = this.deps.store.getMail(requestId);
    if (!req) return;
    const state = this.fold(g.id);
    if (!state.created) return; // legacy parked goal — frozen; deploy waits these out
    const n = [...state.nodes.keys()].filter((k) => k.startsWith("resume_")).length + 1;
    const key = `resume_${n}`;
    const asking = req.from_node ? state.nodes.get(req.from_node) : undefined;
    const brief = (asking ? `${asking.spec.brief}\n\n---\n\n` : "") +
      `Earlier you asked ${req.to_agent}: "${req.body}"\n\nThey answered:\n${answerBody}\n\n` +
      `Continue and complete the task with this answer.`;
    const retargets: Array<{ node: string; dependsOn: string[] }> = [];
    if (asking) {
      for (const other of state.nodes.values()) {
        if (other.spec.dependsOn.includes(asking.spec.key) &&
            !["done", "failed", "skipped"].includes(other.status)) {
          retargets.push({
            node: other.spec.key,
            dependsOn: other.spec.dependsOn.map((k) => (k === asking.spec.key ? key : k)),
          });
        }
      }
    }
    const payload: ReplanRecordedPayload = {
      kind: "resume", forNode: asking?.spec.key ?? null,
      replaced: [],
      added: [{ key, kind: "run", agent: req.from_agent, critic: null, brief,
                dependsOn: asking ? [asking.spec.key] : [], maxRounds: 1 }],
      retargets, reason: "ask-resume",
    };
    this.journal(g.id, [
      { type: "ask.resumed", payload: { mailId: requestId, resumeNodeKey: key } },
      { type: "replan.recorded", payload: payload as unknown as Record<string, unknown> },
    ]);
    this.tick();
  }

  // ---------- boot recovery = replay (spec §9) ----------

  resumeUnfinished(): number {
    // Mail-side recovery stays — mail is not event-sourced (claimMailPlanning survives as-is).
    this.deps.store.reconcilePlanningMail();
    // Parked goals whose answer landed while we were down.
    for (const g of this.deps.store.awaitingMailGoals()) {
      if (!g.awaiting_mail) continue;
      const answer = this.deps.store.mailAnsweringRequest(g.awaiting_mail);
      if (answer) { this.resumeFromAnswer(g.awaiting_mail, answer.body); continue; }
      const req = this.deps.store.getMail(g.awaiting_mail);
      if (req?.status === "refused") this.resumeFromAnswer(g.awaiting_mail, `Refused: ${req.error ?? "unknown"}`);
      else if (req?.kind === "note") this.resumeFromAnswer(g.awaiting_mail, `Declined: ${req.error ?? "chain too deep"}`);
    }
    // Journal goals: dangling attempt.started → attempt.finished{orphaned}; then the
    // normal fold→decide path takes over. No bespoke reset functions.
    const goals = this.deps.store.unfinishedGoals();
    for (const g of [...goals, ...this.deps.store.awaitingMailGoals()]) {
      const state = this.fold(g.id);
      if (!state.created) continue;
      const orphans: EventInput[] = [];
      for (const n of state.nodes.values()) {
        if (n.runningAttempt) {
          orphans.push({ type: "attempt.finished", payload: {
            node: n.spec.key, attempt: n.runningAttempt.attempt, outcome: "orphaned",
            costCents: 0, turns: 0, error: "daemon restarted mid-attempt",
          } });
        }
      }
      if (orphans.length) this.journal(g.id, orphans);
      if (g.status === "replanning" || g.status === "planning") {
        this.deps.store.updateGoalStatus(g.id, "running"); // cosmetic reset; fold re-decides
      }
    }
    const legacyStuck = this.deps.store.listGoals(200)
      .filter((g) => g.legacy === 1 && ["planning", "running", "replanning", "awaiting-mail"].includes(g.status));
    if (legacyStuck.length) {
      this.deps.log?.(`frozen legacy goals still unfinished: ${legacyStuck.map((g) => g.slug).join(", ")} — /abandon was expected pre-deploy`);
    }
    this.tick();
    return goals.length;
  }
}
