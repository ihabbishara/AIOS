import { randomUUID } from "node:crypto";
import { type Playbook, type Stage } from "./playbook.js";
import { roles } from "../agents/roles/index.js";
import { PlaybookExecutor, type JobContext } from "./executor.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { Store, JobRow } from "../store/db.js";
import { VaultWriter, slugify } from "../vault/writer.js";

/** All role names a stage references, across every stage shape. */
export function stageRoles(stage: Stage): string[] {
  switch (stage.type) {
    case "single": return [stage.role];
    case "loop": return [stage.producer, stage.critic];
    case "verify": return [stage.runner, stage.fixer];
  }
}

/** A playbook is "unsandboxed-write" iff it is packless (no pillar → no pack confinement
 *  overrides the role's permissionMode) AND a stage uses a bypassPermissions role. Such a
 *  playbook runs with raw role options (Bash/Write + allowDangerouslySkipPermissions) on the
 *  real filesystem — the in-place coding path that must be gated. */
export function isUnsandboxedWrite(pb: Playbook, pillarOf?: Map<string, string>): boolean {
  if (pillarOf?.get(pb.name)) return false; // has a pillar → pack-confined, not raw
  return pb.stages.some((s) => stageRoles(s).some((r) => roles[r]?.permissionMode === "bypassPermissions"));
}

export interface JobOutcome {
  job: JobRow;
  ok: boolean;
  error?: string;
  jobDirName: string;
  artifactFiles: string[];
}

export interface JobManagerDeps {
  store: Store;
  vault: VaultWriter;
  run: SpecialistRunFn;
  playbooks: Map<string, Playbook>;
  wallTimeMs: number;
  maxConcurrent: number;
  model?: string;
  onComplete: (outcome: JobOutcome) => Promise<void>;
  log?: (line: string) => void;
  onEvent?: (event: import("../events.js").AiosEvent) => void;
  /** Resolve the pack for a playbook, given gate-attribution origin. Undefined for packless. */
  resolvePackFor?: (
    playbookName: string,
    origin: { channel: string; chatId: string },
    sandbox?: { taskDir: string; mode: "build" | "analyze" },
  ) => import("../packs/resolve.js").ResolvedPack | undefined;
  /** Allocate a workspace sandbox before resolving the pack. Optional; undefined → no-op. */
  prepareSandbox?: (job: JobRow, playbook: Playbook) => Promise<{ taskDir: string; mode: "build" | "analyze" } | undefined>;
  /** playbook name -> pillar (from the pack loader); packless playbooks are absent. */
  pillarOf?: Map<string, string>;
}

export class JobManager {
  private running = 0;
  private queue: JobRow[] = [];

  constructor(private deps: JobManagerDeps) {}

  listPlaybooks(): Array<{ name: string; description: string; pillar?: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({
      name: p.name, description: p.description, pillar: this.deps.pillarOf?.get(p.name),
    }));
  }

  createJob(params: {
    playbook: string;
    title: string;
    request: string;
    projectDir?: string;
    channel: string;
    chatId: string;
  }): JobRow {
    const pb = this.deps.playbooks.get(params.playbook);
    if (!pb) throw new Error(`Unknown playbook: ${params.playbook}. Available: ${[...this.deps.playbooks.keys()].join(", ")}`);
    if (pb.needsProjectDir && !params.projectDir) {
      throw new Error(`Playbook ${pb.name} needs a project directory (project_dir).`);
    }
    const id = randomUUID();
    const job: Omit<JobRow, "created_at" | "updated_at" | "job_dir"> = {
      id,
      slug: slugify(params.title),
      title: params.title,
      playbook: params.playbook,
      request: params.request,
      project_dir: params.projectDir ?? null,
      channel: params.channel,
      chat_id: params.chatId,
      status: "queued",
      error: null,
    };
    this.deps.store.insertJob(job);
    const row = this.deps.store.getJob(id)!;
    this.deps.onEvent?.({ type: "job.created", jobId: id, title: row.title, playbook: row.playbook });
    this.enqueue(row);
    return row;
  }

  /** Re-enqueue jobs left queued/running by a previous daemon process. */
  resumeUnfinished(): number {
    const jobs = this.deps.store.unfinishedJobs();
    for (const job of jobs) this.enqueue(job);
    return jobs.length;
  }

  private enqueue(job: JobRow): void {
    this.queue.push(job);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running >= this.deps.maxConcurrent) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running++;
    try {
      await this.runJob(job);
    } finally {
      this.running--;
      void this.pump();
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    const { store, vault, log = () => {} } = this.deps;
    const pb = this.deps.playbooks.get(job.playbook)!;
    const jobDirName = vault.jobDirName(job.slug);
    store.setJobDir(job.id, jobDirName);
    store.updateJobStatus(job.id, "running");
    this.deps.onEvent?.({ type: "job.status", jobId: job.id, status: "running" });
    vault.writeJobArtifact(jobDirName, "job.md",
      `# ${job.title}\n\n- playbook: ${job.playbook}\n- status: running\n- channel: ${job.channel}\n\n## Request\n\n${job.request}`,
      { job: job.id, playbook: job.playbook });
    vault.appendDaily(`job started: [[jobs/${jobDirName}/job|${job.title}]]`);

    let sandbox: { taskDir: string; mode: "build" | "analyze" } | undefined;
    try {
      sandbox = await this.deps.prepareSandbox?.(job, pb);
    } catch (err) {
      store.updateJobStatus(job.id, "failed", `workspace setup failed: ${(err as Error).message}`);
      this.deps.onEvent?.({ type: "job.status", jobId: job.id, status: "failed", error: (err as Error).message });
      await this.deps.onComplete({ job, ok: false, error: (err as Error).message, jobDirName, artifactFiles: [] });
      return;
    }
    if (sandbox) {
      store.setProjectDir(job.id, sandbox.taskDir);
      job.project_dir = sandbox.taskDir;
    }
    const pack = this.deps.resolvePackFor?.(job.playbook, { channel: job.channel, chatId: job.chat_id }, sandbox);
    const executor = new PlaybookExecutor({
      run: this.deps.run,
      store,
      vault,
      model: this.deps.model,
      wallTimeMs: this.deps.wallTimeMs,
      log: (l) => log(`[${job.slug}] ${l}`),
      onEvent: this.deps.onEvent,
      pack,
    });

    let outcome: JobOutcome;
    try {
      const ctx: JobContext = await executor.execute(job, pb, jobDirName);
      store.updateJobStatus(job.id, "done");
      this.deps.onEvent?.({ type: "job.status", jobId: job.id, status: "done" });
      vault.appendDaily(`job done: [[jobs/${jobDirName}/job|${job.title}]]`);
      outcome = { job, ok: true, jobDirName, artifactFiles: ctx.artifacts.map((a) => a.file) };
    } catch (err) {
      const msg = (err as Error).message;
      store.updateJobStatus(job.id, "failed", msg);
      this.deps.onEvent?.({ type: "job.status", jobId: job.id, status: "failed", error: msg });
      vault.appendDaily(`job FAILED: [[jobs/${jobDirName}/job|${job.title}]] — ${msg}`);
      outcome = { job, ok: false, error: msg, jobDirName, artifactFiles: [] };
    }
    try {
      await this.deps.onComplete(outcome);
    } catch (err) {
      log(`[${job.slug}] onComplete failed: ${(err as Error).message}`);
    }
  }
}
