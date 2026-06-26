import { mkdirSync } from "node:fs";
import type { Playbook, Stage } from "./playbook.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { Store, JobRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";

const ARTIFACT_CHAR_LIMIT = 12_000;

/** Thrown when an agent returns a session/quota-limit message instead of real output. */
export class SessionLimitError extends Error {
  readonly name = "SessionLimitError";
  constructor(message: string) {
    super(message);
  }
}

const SESSION_LIMIT_PATTERNS = [
  "you've hit your session limit",
  "hit your session limit",
] as const;

function isSessionLimitOutput(text: string): boolean {
  const lower = text.toLowerCase().trimStart();
  return SESSION_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

export interface Artifact {
  stageId: string;
  role: string;
  file: string;
  content: string;
}

export interface JobContext {
  job: JobRow;
  jobDirName: string;
  artifacts: Artifact[];
}

export interface ExecutorDeps {
  run: SpecialistRunFn;
  store: Store;
  vault: VaultWriter;
  model?: string;
  wallTimeMs: number;
  log?: (line: string) => void;
  onEvent?: (event: import("../events.js").AiosEvent) => void;
  /** Resolved pack for this job's playbook (undefined for packless playbooks). */
  pack?: import("../packs/resolve.js").ResolvedPack;
}

export interface Verdict {
  verdict: "approve" | "revise";
  summary: string;
  reasons: string[];
}

export interface TestReport {
  passed: boolean;
  summary: string;
  failures: string[];
}

function truncate(text: string, limit = ARTIFACT_CHAR_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n[...truncated]`;
}

function contextBlock(ctx: JobContext): string {
  const parts = [
    `# Task\n${ctx.job.request}`,
    ctx.job.project_dir ? `# Working directory\n${ctx.job.project_dir}` : "",
  ];
  for (const a of ctx.artifacts) {
    parts.push(`# Prior artifact: ${a.file} (by ${a.role})\n${truncate(a.content)}`);
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

export class PlaybookExecutor {
  constructor(private deps: ExecutorDeps) {}

  /** Runs (or resumes) every stage of the playbook for the job. Throws on hard failure. */
  async execute(job: JobRow, playbook: Playbook, jobDirName: string): Promise<JobContext> {
    const { store, vault, log = () => {} } = this.deps;
    const deadline = Date.now() + this.deps.wallTimeMs;
    const completed = store.completedStages(job.id);
    const ctx: JobContext = { job, jobDirName, artifacts: [] };

    // Rehydrate artifacts from completed stages so resume has full context.
    for (const stage of playbook.stages) {
      if (!completed.has(stage.id)) continue;
      const file = `${stage.id}.md`;
      const content = vault.readJobArtifact(jobDirName, file);
      if (content) {
        ctx.artifacts.push({ stageId: stage.id, role: roleOf(stage), file, content });
      }
    }

    for (const stage of playbook.stages) {
      if (completed.has(stage.id)) {
        log(`stage ${stage.id}: already done, skipping`);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Job wall-time budget exceeded before stage ${stage.id}`);

      store.stageStart(job.id, stage.id);
      log(`stage ${stage.id}: starting (${stage.type})`);
      this.deps.onEvent?.({ type: "stage.start", jobId: job.id, stageId: stage.id, kind: stage.type });
      try {
        await this.runStageWithRetry(stage, ctx);
        store.stageFinish(job.id, stage.id, "done");
        this.deps.onEvent?.({ type: "stage.finish", jobId: job.id, stageId: stage.id, status: "done" });
        vault.appendDaily(`[[jobs/${jobDirName}/${stage.id}|${job.slug}/${stage.id}]] done`);
      } catch (err) {
        store.stageFinish(job.id, stage.id, "failed");
        this.deps.onEvent?.({ type: "stage.finish", jobId: job.id, stageId: stage.id, status: "failed" });
        throw err;
      }
    }
    return ctx;
  }

  private async runStageWithRetry(stage: Stage, ctx: JobContext): Promise<void> {
    try {
      await this.runStage(stage, ctx);
    } catch (err) {
      // Quota errors must not be retried — the limit is still active and a
      // second attempt would produce the same message and waste time.
      if (err instanceof SessionLimitError) throw err;
      this.deps.log?.(`stage ${stage.id}: failed (${(err as Error).message}), retrying once`);
      await this.runStage(stage, ctx);
    }
  }

  private runOpts(ctx: JobContext) {
    // New-workspace jobs name a project_dir that a later scaffold stage creates,
    // but stage 1 (research) already spawns the SDK with it as cwd. A missing cwd
    // fails spawn with ENOENT, which the SDK misreports as "native binary failed
    // to launch". Create it up front so every stage has a real working directory.
    const cwd = ctx.job.project_dir ?? process.cwd();
    mkdirSync(cwd, { recursive: true });
    return {
      cwd,
      model: this.deps.model,
      pack: this.deps.pack,
    };
  }

  /** Runs a specialist with agent start/end telemetry. */
  private async runAgent(role: string, brief: string, ctx: JobContext, stageId: string) {
    const context = `job:${ctx.job.slug}/${stageId}`;
    this.deps.onEvent?.({ type: "agent.start", agent: role, context });
    try {
      const res = await this.deps.run(role, brief, this.runOpts(ctx));

      // Guard: the SDK delivers quota-exhaustion as a "success" with the limit
      // message in res.text. Detect it here and convert to a hard failure so the
      // job is never marked "done" with empty/garbage output.
      if (isSessionLimitOutput(res.text)) {
        this.deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
        throw new SessionLimitError(
          "Agent hit session limit — re-run after quota resets",
        );
      }

      this.deps.onEvent?.({
        type: "agent.end", agent: role, context, ok: true,
        costUsd: res.costUsd, turns: res.numTurns,
      });
      return res;
    } catch (err) {
      if (err instanceof SessionLimitError) throw err; // agent.end already emitted above
      this.deps.onEvent?.({ type: "agent.end", agent: role, context, ok: false });
      throw err;
    }
  }

  private saveArtifact(ctx: JobContext, stageId: string, role: string, file: string, content: string): void {
    this.deps.vault.writeJobArtifact(ctx.jobDirName, file, content, {
      job: ctx.job.id,
      stage: stageId,
      role,
    });
  }

  private pushArtifact(ctx: JobContext, stageId: string, role: string, file: string, content: string): void {
    this.saveArtifact(ctx, stageId, role, file, content);
    ctx.artifacts.push({ stageId, role, file, content });
  }

  private async runStage(stage: Stage, ctx: JobContext): Promise<void> {
    switch (stage.type) {
      case "single": {
        const brief = [stage.brief, contextBlock(ctx)].filter(Boolean).join("\n\n");
        const res = await this.runAgent(stage.role, brief, ctx, stage.id);
        this.pushArtifact(ctx, stage.id, stage.role, `${stage.id}.md`, res.text);
        return;
      }

      case "loop": {
        let feedback = "";
        let lastOutput = "";
        let approved = false;
        for (let round = 1; round <= stage.maxRounds; round++) {
          const producerBrief = [
            stage.brief,
            contextBlock(ctx),
            feedback ? `# Reviewer feedback (round ${round - 1}) — address every point\n${feedback}` : "",
            lastOutput ? `# Your previous version\n${truncate(lastOutput)}` : "",
          ].filter(Boolean).join("\n\n");

          const produced = await this.runAgent(stage.producer, producerBrief, ctx, stage.id);
          lastOutput = produced.text;
          this.saveArtifact(ctx, stage.id, stage.producer, `${stage.id}-v${round}.md`, produced.text);

          const criticBrief = [
            `Review the following ${stage.producer} output against the original task.`,
            contextBlock(ctx),
            `# Output under review (round ${round})\n${truncate(produced.text)}`,
          ].join("\n\n");
          const review = await this.runAgent(stage.critic, criticBrief, ctx, stage.id);
          const verdict = review.structured as Verdict | undefined;
          this.saveArtifact(
            ctx, stage.id, stage.critic, `${stage.id}-review-${round}.md`,
            verdict ? `**Verdict:** ${verdict.verdict}\n\n${verdict.summary}\n\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}` : review.text,
          );

          if (verdict?.verdict === "approve") {
            approved = true;
            break;
          }
          feedback = verdict
            ? [verdict.summary, ...verdict.reasons].join("\n- ")
            : review.text;
        }
        const note = approved ? "" : `\n\n> [!warning] Loop cap reached (${stage.maxRounds} rounds) without approval — proceeding with last version.\n`;
        this.pushArtifact(ctx, stage.id, stage.producer, `${stage.id}.md`, lastOutput + note);
        return;
      }

      case "verify": {
        let report: TestReport | undefined;
        for (let round = 1; round <= stage.maxRounds; round++) {
          const runnerBrief = [stage.brief, contextBlock(ctx), "Run the verification now."].filter(Boolean).join("\n\n");
          const res = await this.runAgent(stage.runner, runnerBrief, ctx, stage.id);
          report = res.structured as TestReport | undefined;
          this.saveArtifact(
            ctx, stage.id, stage.runner, `${stage.id}-run-${round}.md`,
            report ? `**Passed:** ${report.passed}\n\n${report.summary}\n\n${report.failures.map((f) => `- ${f}`).join("\n")}` : res.text,
          );

          if (!report || report.passed) break;
          if (round === stage.maxRounds) break;

          const fixBrief = [
            contextBlock(ctx),
            `# Failing verification (round ${round}) — fix these\n${report.summary}\n${report.failures.map((f) => `- ${f}`).join("\n")}`,
          ].join("\n\n");
          const fix = await this.runAgent(stage.fixer, fixBrief, ctx, stage.id);
          this.saveArtifact(ctx, stage.id, stage.fixer, `${stage.id}-fix-${round}.md`, fix.text);
        }
        const summary = report
          ? `**Passed:** ${report.passed}\n\n${report.summary}${report.failures.length ? `\n\nFailures:\n${report.failures.map((f) => `- ${f}`).join("\n")}` : ""}`
          : "No structured test report produced.";
        this.pushArtifact(ctx, stage.id, stage.runner, `${stage.id}.md`, summary);
        if (report && !report.passed) {
          // Surfaced, not thrown: the job completes with a failing-tests report the user can act on.
          this.deps.log?.(`stage ${stage.id}: verification still failing after ${stage.maxRounds} rounds`);
        }
        return;
      }
    }
  }
}

function roleOf(stage: Stage): string {
  switch (stage.type) {
    case "single": return stage.role;
    case "loop": return stage.producer;
    case "verify": return stage.runner;
  }
}
