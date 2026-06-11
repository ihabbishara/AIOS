import { randomUUID } from "node:crypto";
import type { Playbook } from "./playbook.js";
import { PlaybookExecutor, type JobContext } from "./executor.js";
import type { SpecialistRunFn } from "../agents/runner.js";
import type { Store, JobRow } from "../store/db.js";
import { VaultWriter, slugify } from "../vault/writer.js";

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
}

export class JobManager {
  private running = 0;
  private queue: JobRow[] = [];

  constructor(private deps: JobManagerDeps) {}

  listPlaybooks(): Array<{ name: string; description: string }> {
    return [...this.deps.playbooks.values()].map((p) => ({ name: p.name, description: p.description }));
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
    const job: Omit<JobRow, "created_at" | "updated_at"> = {
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
    store.updateJobStatus(job.id, "running");
    vault.writeJobArtifact(jobDirName, "job.md",
      `# ${job.title}\n\n- playbook: ${job.playbook}\n- status: running\n- channel: ${job.channel}\n\n## Request\n\n${job.request}`,
      { job: job.id, playbook: job.playbook });
    vault.appendDaily(`job started: [[jobs/${jobDirName}/job|${job.title}]]`);

    const executor = new PlaybookExecutor({
      run: this.deps.run,
      store,
      vault,
      model: this.deps.model,
      wallTimeMs: this.deps.wallTimeMs,
      log: (l) => log(`[${job.slug}] ${l}`),
    });

    let outcome: JobOutcome;
    try {
      const ctx: JobContext = await executor.execute(job, pb, jobDirName);
      store.updateJobStatus(job.id, "done");
      vault.appendDaily(`job done: [[jobs/${jobDirName}/job|${job.title}]]`);
      outcome = { job, ok: true, jobDirName, artifactFiles: ctx.artifacts.map((a) => a.file) };
    } catch (err) {
      const msg = (err as Error).message;
      store.updateJobStatus(job.id, "failed", msg);
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
