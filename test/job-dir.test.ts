import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { JobManager } from "../src/engine/jobs.js";
import type { Playbook } from "../src/engine/playbook.js";

function seedJob(s: Store, id: string) {
  s.insertJob({
    id, slug: "alpha", title: "Alpha", playbook: "research-report", request: "q",
    project_dir: null, channel: "system", chat_id: "x", status: "queued", error: null,
  });
}

describe("job_dir persistence", () => {
  it("setJobDir stores the dir and getJob returns it; null until set", () => {
    const s = new Store(":memory:");
    seedJob(s, "j1");
    expect(s.getJob("j1")!.job_dir).toBeNull();
    s.setJobDir("j1", "2026-06-20-alpha");
    expect(s.getJob("j1")!.job_dir).toBe("2026-06-20-alpha");
  });

  it("migration is idempotent — reopening a file-backed DB does not throw and keeps data", () => {
    const dir = mkdtempSync(join(tmpdir(), "aios-db-"));
    const path = join(dir, "t.sqlite");
    const a = new Store(path);
    seedJob(a, "j1");
    a.setJobDir("j1", "2026-06-20-alpha");
    const b = new Store(path); // re-runs the ALTER (caught) on an existing table
    expect(b.getJob("j1")!.job_dir).toBe("2026-06-20-alpha");
    rmSync(dir, { recursive: true, force: true });
  });

  it("runJob stamps job_dir = vault.jobDirName(slug) when a job completes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aios-vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    const pb: Playbook = {
      name: "research-report", description: "d", needsProjectDir: false,
      stages: [{ type: "single", id: "report", role: "researcher" }],
    };
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const jm = new JobManager({
      store, vault,
      run: (async () => ({ text: "the report", costUsd: 0, numTurns: 1 })) as never,
      playbooks: new Map([["research-report", pb]]),
      wallTimeMs: 60_000, maxConcurrent: 1,
      onComplete: async () => { done(); },
    });
    const job = jm.createJob({ playbook: "research-report", title: "Alpha", request: "q", channel: "system", chatId: "x" });
    await finished;
    const row = store.getJob(job.id)!;
    expect(row.status).toBe("done");
    expect(row.job_dir).toBe(vault.jobDirName("alpha")); // `${UTC-today}-alpha`
    rmSync(root, { recursive: true, force: true });
  });
});
