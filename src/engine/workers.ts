// src/engine/workers.ts — attempt runner + abort registry. A worker executes one
// StartAttempt command: claims it via attempt.started (a lost optimistic-gseq claim
// means another context owns it — drop silently), runs the node kind with per-round
// journal events, and closes with attempt.finished. Crash mid-loop resumes at round N
// with the critic's last feedback, not round 1.
import type { Store, GoalRow, TaskNodeRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import { SpecialistError, type SpecialistRunFn, type DeniedTool } from "../agents/runner.js";
import { WORK_REPORT_SCHEMA } from "../agents/roles/index.js";
import type { AiosEvent } from "../events.js";
import {
  appendEvents, attemptClaimed, readJournal,
  type NodeSpec, type AttemptOutcome, type EventInput,
  type AttemptStartedPayload, type RoundRecordedPayload,
} from "./journal.js";
import { reduce } from "./reduce.js";

const ARTIFACT_CHAR_LIMIT = 12_000;

/** Prefix on the attempt error a `completed:false` work report produces. Exported because the
 *  retry brief reads it back off NodeState.lastError — a string contract between this file and
 *  itself, so tests pin both directions. */
export const BLOCKED_PREFIX = "did not complete: ";

/** Backoff before each in-place retry of an unreachable API call. */
const API_RETRY_BACKOFF_MS = [5_000, 15_000] as const;

export class SessionLimitError extends Error {
  readonly name = "SessionLimitError";
}

const SESSION_LIMIT_PATTERNS = ["you've hit your session limit", "hit your session limit"] as const;
function isSessionLimitOutput(text: string): boolean {
  const lower = text.toLowerCase().trimStart();
  return SESSION_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

export class ApiUnreachableError extends Error {
  readonly name = "ApiUnreachableError";
}

/** The SDK reports transport failures as TEXT, not by throwing, so output is the only signal.
 *  Matches the WHOLE `API Error:` envelope family — "Unable to connect to API", "Connection
 *  closed mid-response", and siblings. Narrowing this to one phrasing is what let
 *  "Connection closed mid-response" through as a DONE artifact (facts-macro.md).
 *  Still anchored on startsWith: agents legitimately write about connection failures inside
 *  real reports, and matching mid-text would pause a healthy goal. */
export function isApiErrorOutput(text: string): boolean {
  return text.toLowerCase().trimStart().startsWith("api error:");
}

export interface Verdict { verdict: "approve" | "revise"; summary: string; reasons: string[] }
export interface TestReport { passed: boolean; summary: string; failures: string[] }
export interface WorkReport { completed: boolean; summary: string; blockers: string[] }

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

function contextBlock(goal: GoalRow, ancestors: TaskNodeRow[], vault: VaultWriter): string {
  const parts = [
    `# Task\n${goal.request}`,
    goal.project_dir ? `# Working directory\n${goal.project_dir}` : "",
    // Without this, agents search the filesystem from cwd, conclude their own goal's files do
    // not exist, and either stall or refuse — while the files sit in the vault and the agent
    // has had vault_read the whole time.
    goal.goal_dir
      ? `# Goal folder (in the vault, NOT on the filesystem)\nThis goal's files live at \`goals/${goal.goal_dir}/\`. Read and write them with vault_read / vault_write using that exact path. Do NOT look for them with Read/Grep/Glob relative to your working directory — they are not there.`
      : "",
  ];
  for (const a of ancestors) {
    const content = vault.readGoalArtifact(goal.goal_dir!, a.artifact!) ?? "";
    parts.push(`# Prior artifact: ${a.artifact} (by ${a.agent})\n${truncate(content)}`);
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

/** One AbortController per in-flight attempt, keyed goalId:node:attempt. The engine's
 *  clock tick aborts past-deadline attempts; crossing the budget cap aborts everything. */
export class AbortRegistry {
  private controllers = new Map<string, AbortController>();
  private reasons = new Map<string, "timeout" | "budget" | "abandoned">();

  key(goalId: string, node: string, attempt: number): string {
    return `${goalId}:${node}:${attempt}`;
  }
  register(key: string): AbortController {
    const c = new AbortController();
    this.controllers.set(key, c);
    return c;
  }
  abort(key: string, reason: "timeout" | "budget" | "abandoned"): void {
    const c = this.controllers.get(key);
    if (!c) return;
    this.reasons.set(key, reason);
    c.abort();
  }
  abortAll(reason: "timeout" | "budget" | "abandoned"): void {
    for (const key of [...this.controllers.keys()]) this.abort(key, reason);
  }
  reason(key: string): "timeout" | "budget" | "abandoned" | undefined {
    return this.reasons.get(key);
  }
  finish(key: string): void {
    this.controllers.delete(key);
    this.reasons.delete(key);
  }
  size(): number { return this.controllers.size; }
}

export interface WorkerDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  log?: (l: string) => void;
  onEvent?: (e: AiosEvent) => void;
  /** Sandbox workspace for this goal (engine computes per goal) — resolveAgent builds the code server from it. */
  workspace?: { taskDir: string; mode: "build" | "analyze" };
  registry: AbortRegistry;
  nodeTimeoutMs: number;
  /** Injected so tests never actually wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Queue an always-supervised permission.grant (policy-wall spec §3). Optional — absent in
   *  tests and stripped-down harnesses; the park still names the tool either way. */
  proposeGrant?: (role: string, tool: string) => Promise<void>;
}

export interface AttemptResult {
  claimed: boolean;
  outcome: AttemptOutcome | null;
  sessionLimit: boolean;
  /** The API was unreachable after retries — the engine pauses instead of failing (spec §2). */
  apiUnreachable: boolean;
}

export async function runAttempt(
  goal: GoalRow, spec: NodeSpec, attempt: number, deps: WorkerDeps,
): Promise<AttemptResult> {
  const { store, vault } = deps;
  const regKey = deps.registry.key(goal.id, spec.key, attempt);
  const deadlineTs = Date.now() + (spec.kind === "run" ? 1 : 2) * deps.nodeTimeoutMs;
  const startedPayload: AttemptStartedPayload = {
    node: spec.key, attempt, agent: spec.agent, deadlineTs,
    idempotencyKey: `${goal.id}:${spec.key}:${attempt}`,
  };
  const claimed = appendEvents(store, goal.id,
    [{ type: "attempt.started", payload: startedPayload as unknown as Record<string, unknown> }],
    { claimLost: attemptClaimed(spec.key, attempt) });
  if (!claimed) return { claimed: false, outcome: null, sessionLimit: false, apiUnreachable: false };
  deps.onEvent?.({ type: "node.status", goalId: goal.id, nodeKey: spec.key, status: "running", agent: spec.agent });

  const controller = deps.registry.register(regKey);
  let costCents = 0;
  let turns = 0;
  const denied = new Map<string, DeniedTool>(); // key role:tool — all runAgent calls of this attempt feed it
  const collectDenials = (ds?: DeniedTool[]): void => {
    for (const d of ds ?? []) denied.set(`${d.role}:${d.tool}`, d);
  };

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const runAgent = async (role: string, brief: string, outputSchema?: Record<string, unknown>) => {
    const context = `goal:${goal.slug}/${spec.key}`;
    deps.onEvent?.({ type: "agent.start", agent: role, context });
    try {
      for (let tryIdx = 0; ; tryIdx++) {
        const res = await deps.run(role, brief, {
          cwd: goal.project_dir ?? process.cwd(),
          signal: controller.signal,
          origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id },
          workspace: deps.workspace,
          idempotencyKey: `${goal.id}:${spec.key}:${attempt}`,
          ...(outputSchema ? { outputSchema } : {}),
          ...(maxTurnsFactor ? { maxTurnsFactor } : {}),
          mailCtx: {
            origin: { channel: goal.origin_channel, chatId: goal.origin_chat_id },
            goalDepth: goal.chain_depth, goalId: goal.id, nodeKey: spec.key,
          },
        });
        // A transient outage must not be charged to the agent. Retry in place for micro-blips;
        // a sustained outage becomes ApiUnreachableError and the engine pauses the goal.
        if (isApiErrorOutput(res.text)) {
          if (tryIdx < API_RETRY_BACKOFF_MS.length) {
            await sleep(API_RETRY_BACKOFF_MS[tryIdx]);
            continue;
          }
          deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
          throw new ApiUnreachableError(res.text.trim());
        }
        if (isSessionLimitOutput(res.text)) {
          deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
          throw new SessionLimitError("Agent hit session limit — re-run after quota resets");
        }
        deps.onEvent?.({ type: "agent.end", agent: role, context, ok: true, costUsd: res.costUsd, turns: res.numTurns });
        costCents += Math.round((res.costUsd ?? 0) * 100);
        turns += res.numTurns ?? 0;
        collectDenials(res.denials);
        return res;
      }
    } catch (err) {
      if (!(err instanceof SessionLimitError) && !(err instanceof ApiUnreachableError)) {
        deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
      }
      throw err;
    }
  };

  /** A node artifact lives at `<node_key>.md` — the very name a well-behaved agent picks for its
   *  own output via vault_write. Overwriting it silently destroyed a real deck outline once.
   *  Keep the agent's file; put the node artifact beside it and journal THAT name. A re-run of
   *  the same node still overwrites its own artifact (recognised by its `node:` frontmatter),
   *  so retries never proliferate files. Returns the filename actually written. */
  const save = (file: string, content: string, role: string): string => {
    const mine = (name: string): boolean => {
      const existing = vault.readGoalArtifact(goal.goal_dir!, name);
      return existing === undefined || existing.includes(`node: ${JSON.stringify(spec.key)}`);
    };
    let target = file;
    for (let n = 1; !mine(target) && n <= 20; n++) target = file.replace(/\.md$/, `-report${n > 1 ? n : ""}.md`);
    vault.writeGoalArtifact(goal.goal_dir!, target, content, { goal: goal.id, node: spec.key, role });
    return target;
  };
  const recordRound = (payload: RoundRecordedPayload): void => {
    appendEvents(store, goal.id, [{ type: "round.recorded", payload: payload as unknown as Record<string, unknown> }]);
  };
  const finish = (outcome: AttemptOutcome, error?: string, final?: { artifactRef: string; roundsUsed: number }, uncounted?: boolean): void => {
    const events: EventInput[] = [{
      type: "attempt.finished",
      payload: { node: spec.key, attempt, outcome, costCents, turns, ...(error ? { error } : {}), ...(uncounted ? { uncounted: true } : {}) },
    }];
    if (final) {
      // A node parked via ask_mail is already done — never re-complete it.
      const st = reduce(readJournal(store, goal.id)).nodes.get(spec.key);
      if (st?.status !== "done") {
        events.push({ type: "node.completed", payload: { node: spec.key, artifactRef: final.artifactRef, roundsUsed: final.roundsUsed } });
      }
    }
    appendEvents(store, goal.id, events);
  };
  /** Fresh fold — resume data (rounds, feedback, last artifact) survives crashes/retries. */
  const nodeState = () => reduce(readJournal(store, goal.id)).nodes.get(spec.key);

  /** error_max_turns retry class (failure-class spec §B): the same brief with the same cap
   *  would burn this attempt identically, so the retry runs at 2× the role's turn cap. */
  const maxTurnsFactor =
    attempt > 1 && (nodeState()?.lastError ?? "").includes("error_max_turns") ? 2 : undefined;

  /** Agent-caused error funnel (policy-wall spec §2): if the attempt hit denied tools, park
   *  needs-review naming each wall instead of joining the retry treadmill — the retry would
   *  hit the same wall. Infra outcomes (timeout/abort/session-limit/api) never come here. */
  const finishOrPark = (error: string): void => {
    if (denied.size === 0) { finish("error", error); return; }
    const walls = [...denied.values()];
    for (const d of walls.filter((w) => w.layer === "allowlist")) {
      // Fire-and-forget: a gate failure must not lose the park; objections still name the tool.
      void deps.proposeGrant?.(d.role, d.tool).catch((e) =>
        deps.log?.(`proposeGrant ${d.role}/${d.tool} failed: ${(e as Error).message}`));
    }
    const objections = walls.map((d) => d.layer === "allowlist"
      ? `${d.role} was denied: ${d.tool} (not in allowlist). A permission grant is queued in Actions — approve it (or reject), then Retry.`
      : `${d.role} was denied: ${d.tool} — "${d.reason}". This is engine policy, not a grantable permission; fix the cause (e.g. reopen with guidance, or give the goal a workspace) and Retry.`);
    const artifact = save(`${spec.key}-a${attempt}-denied.md`,
      `# Attempt ${attempt} blocked by denied tools\n\n**Error:** ${error}\n\n${objections.map((o) => `- ${o}`).join("\n")}`,
      spec.agent);
    appendEvents(store, goal.id, [
      { type: "attempt.finished", payload: { node: spec.key, attempt, outcome: "error", costCents, turns, error } },
      { type: "review.requested", payload: { node: spec.key, lastArtifactRef: artifact, objections } },
    ]);
    deps.onEvent?.({ type: "node.status", goalId: goal.id, nodeKey: spec.key, status: "needs-review", agent: spec.agent });
  };

  try {
    const ctx = contextBlock(goal, ancestorArtifacts(store.listNodes(goal.id), spec.key), vault);
    switch (spec.kind) {
      case "run": {
        // A deterministic refusal ("the source file does not exist") re-fails identically if the
        // retry brief is byte-identical, burning the second attempt for nothing. The prefix test
        // is what keeps this honest: lastError also holds timeouts and wall-clock messages, and
        // only errors this file wrote are read back.
        const st = nodeState();
        const priorError = st?.lastError;
        const priorBlockers = priorError?.startsWith(BLOCKED_PREFIX) ? priorError.slice(BLOCKED_PREFIX.length) : "";
        // Guidance was unreachable for run nodes until goal.reopened (they never park for
        // review); same block, exact same string, as loop/verify. After a reopen lastError is
        // null (the fold wiped it), so guidance and blockers never collide from a reopen —
        // they CAN co-exist on a normal ⑭-gated retry, and both appearing is intended.
        const runGuidance = st?.reviewGuidance;
        const brief = [
          spec.brief, ctx,
          runGuidance ? `# User guidance (from review) — follow this\n${runGuidance}` : "",
          priorBlockers && `# Your previous attempt reported it could not complete\n${priorBlockers}\n\nResolve these, or report completed:false again with what is still missing.`,
        ].filter(Boolean).join("\n\n");
        const res = await runAgent(spec.agent, brief, WORK_REPORT_SCHEMA);
        // A run node has no structured-output gate, so ANY text became a "done" artifact and
        // downstream nodes consumed it as fact. The transport-error family is caught in
        // runAgent; empty output is the remaining way to complete a node having produced nothing.
        if (!res.text.trim()) {
          finishOrPark("agent returned no output");
          return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: false };
        }
        // Articulate prose saying "I could not do this" was the remaining false success: 1.4KB of
        // organised markdown, non-empty, no API-error envelope, journaled ok and consumed by the
        // next node as fact (goal c03a3bda, twice). The agent now attests instead.
        // `=== false` and NOT `!completed`: an agent carrying its own manifest schema returns a
        // TestReport/Verdict here (runner.ts:142 lets role.outputSchema win), where `completed` is
        // undefined — a truthiness test would error a node whose work was fine.
        const rep = res.structured as Partial<WorkReport> | undefined;
        if (rep?.completed === false) {
          finishOrPark(`${BLOCKED_PREFIX}${rep.blockers?.join("; ") || rep.summary || "no reason given"}`);
          return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: false };
        }
        // ponytail: lenient — a missing report keeps today's rule rather than erroring like verify
        // does (the `if (!report)` gate below). This gate sits in front of EVERY run node, and
        // making the fleet depend on a tool call landing after an 80-turn write risks the same
        // infrastructure-kills-goals harm the api-unreachable work just removed. Flip to strict
        // once these log lines go quiet in the wild.
        if (!rep) deps.log?.(`${spec.key}: no work report (agent ${spec.agent})`);
        const file = `${spec.key}.md`;
        finish("ok", undefined, { artifactRef: save(file, res.text, spec.agent), roundsUsed: 0 });
        break;
      }
      case "loop": {
        const st = nodeState();
        let feedback = st?.lastFeedback ?? "";
        let lastOutput = st?.lastArtifactRef ? (vault.readGoalArtifact(goal.goal_dir!, st.lastArtifactRef) ?? "") : "";
        let approved = st?.lastVerdict?.verdict === "approve";
        let lastReasons: string[] = st?.lastVerdict?.reasons ?? [];
        let round = st?.currentRound ?? 0;
        const guidance = st?.reviewGuidance;
        while (!approved && round < spec.maxRounds) {
          round++;
          const producerBrief = [
            spec.brief, ctx,
            guidance ? `# User guidance (from review) — follow this\n${guidance}` : "",
            feedback ? `# Reviewer feedback (round ${round - 1}) — address every point\n${feedback}` : "",
            lastOutput ? `# Your previous version\n${truncate(lastOutput)}` : "",
          ].filter(Boolean).join("\n\n");
          const produced = await runAgent(spec.agent, producerBrief);
          lastOutput = produced.text;
          save(`${spec.key}-a${attempt}-v${round}.md`, produced.text, spec.agent);

          const criticBrief = [
            `Review the following ${spec.agent} output against the original task.`,
            ctx,
            `# Output under review (round ${round})\n${truncate(produced.text)}`,
          ].join("\n\n");
          const review = await runAgent(spec.critic!, criticBrief);
          const verdict = review.structured as Verdict | undefined;
          save(`${spec.key}-a${attempt}-review-${round}.md`,
            verdict ? `**Verdict:** ${verdict.verdict}\n\n${verdict.summary}\n\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}` : review.text,
            spec.critic!);
          feedback = verdict ? [verdict.summary, ...verdict.reasons].join("\n- ") : review.text;
          if (verdict) lastReasons = verdict.reasons;
          recordRound({ node: spec.key, attempt, round, role: "critic", verdict, feedback, artifactRef: `${spec.key}-a${attempt}-v${round}.md` });
          if (verdict?.verdict === "approve") approved = true;
        }
        if (!approved) {
          // Cap reached without approval: escalate, don't proceed (spec §4). One atomic
          // append — a crash can never leave a finished attempt without its park.
          appendEvents(store, goal.id, [
            { type: "attempt.finished", payload: { node: spec.key, attempt, outcome: "ok", costCents, turns } },
            { type: "review.requested", payload: { node: spec.key, lastArtifactRef: `${spec.key}-a${attempt}-v${round}.md`, objections: lastReasons } },
          ]);
          break;
        }
        const file = `${spec.key}.md`;
        finish("ok", undefined, { artifactRef: save(file, lastOutput, spec.agent), roundsUsed: round });
        break;
      }
      case "verify": {
        const st = nodeState();
        let report: TestReport | undefined = st?.lastReport ?? undefined;
        let round = st?.runnerRounds ?? 0;
        let fixedThrough = st?.fixerRounds ?? 0;
        const guidance = st?.reviewGuidance;
        let lastRunnerText = "";
        // (!report && round > 0) = a fresh retry after a no-report attempt: run the runner again.
        while (round < spec.maxRounds && (!report || !report.passed)) {
          if (round > 0 && report && !report.passed && fixedThrough < round) {
            const fixBrief = [
              ctx,
              guidance ? `# User guidance (from review) — follow this\n${guidance}` : "",
              `# Failing verification (round ${round}) — fix these\n${report.summary}\n${report.failures.map((f) => `- ${f}`).join("\n")}`,
            ].filter(Boolean).join("\n\n");
            const fix = await runAgent(spec.critic!, fixBrief);
            save(`${spec.key}-a${attempt}-fix-${round}.md`, fix.text, spec.critic!);
            recordRound({ node: spec.key, attempt, round, role: "fixer", feedback: report.summary, artifactRef: `${spec.key}-a${attempt}-fix-${round}.md` });
            fixedThrough = round;
          }
          round++;
          const runnerBrief = [spec.brief, ctx, "Run the verification now."].filter(Boolean).join("\n\n");
          const res = await runAgent(spec.agent, runnerBrief);
          report = res.structured as TestReport | undefined;
          lastRunnerText = res.text;
          save(`${spec.key}-a${attempt}-run-${round}.md`,
            report ? `**Passed:** ${report.passed}\n\n${report.summary}\n\n${report.failures.map((f) => `- ${f}`).join("\n")}` : res.text,
            spec.agent);
          recordRound({
            node: spec.key, attempt, round, role: "runner", report,
            feedback: report && !report.passed ? [report.summary, ...report.failures].join("\n- ") : "",
            artifactRef: `${spec.key}-a${attempt}-run-${round}.md`,
          });
          if (!report) break;
        }
        if (!report) {
          // No parseable TestReport = the verification never ran — a failed attempt,
          // never a silent pass (spec §3). Normal attempt policy retries once.
          // Carry what the agent DID say: reading this error should not require opening the vault.
          const snippet = lastRunnerText.trim().replace(/\s+/g, " ").slice(0, 200);
          save(`${spec.key}.md`, "No structured test report produced.", spec.agent);
          finishOrPark(snippet ? `no structured report (last output: "${snippet}")` : "no structured report");
          return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: false };
        }
        if (!report.passed) {
          // Verification ran and FAILED at the cap — same escalation as loop-cap (spec §4).
          // Failures become the outstanding objections.
          appendEvents(store, goal.id, [
            { type: "attempt.finished", payload: { node: spec.key, attempt, outcome: "ok", costCents, turns } },
            { type: "review.requested", payload: {
              node: spec.key, lastArtifactRef: `${spec.key}-a${attempt}-run-${round}.md`,
              objections: [report.summary, ...report.failures],
            } },
          ]);
          break;
        }
        const summary = `**Passed:** true\n\n${report.summary}`;
        const file = `${spec.key}.md`;
        finish("ok", undefined, { artifactRef: save(file, summary, spec.agent), roundsUsed: round });
        break;
      }
    }
    return { claimed: true, outcome: "ok", sessionLimit: false, apiUnreachable: false };
  } catch (err) {
    if (err instanceof SessionLimitError) {
      // ⑰ §A1: quota exhaustion is infra, not the agent — the attempt must not count.
      finish("error", err.message, undefined, true);
      return { claimed: true, outcome: "error", sessionLimit: true, apiUnreachable: false };
    }
    if (err instanceof ApiUnreachableError) {
      finish("error", err.message, undefined, true);
      return { claimed: true, outcome: "error", sessionLimit: false, apiUnreachable: true };
    }
    const abortReason = deps.registry.reason(regKey);
    const outcome: AttemptOutcome =
      abortReason === "timeout" ? "timeout" : abortReason ? "aborted" : "error";
    if (err instanceof SpecialistError) collectDenials(err.denials);
    if (outcome === "error") finishOrPark((err as Error).message);
    else finish(outcome, (err as Error).message);
    return { claimed: true, outcome, sessionLimit: false, apiUnreachable: false };
  } finally {
    deps.registry.finish(regKey);
  }
}
