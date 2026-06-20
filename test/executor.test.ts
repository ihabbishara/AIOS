import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaybookExecutor } from "../src/engine/executor.js";
import { playbookSchema, type Playbook } from "../src/engine/playbook.js";
import { Store, type JobRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import type { SpecialistResult, RunOptions } from "../src/agents/runner.js";

type Call = { role: string; brief: string };

function makeJob(): JobRow {
  return {
    id: "job-1",
    slug: "test-job",
    title: "Test job",
    playbook: "pb",
    request: "Build the thing",
    project_dir: null,
    job_dir: null,
    channel: "cli",
    chat_id: "local",
    status: "running",
    error: null,
    created_at: "",
    updated_at: "",
  };
}

describe("PlaybookExecutor", () => {
  let tmp: string;
  let store: Store;
  let vault: VaultWriter;
  let calls: Call[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "aios-test-"));
    store = new Store(":memory:");
    vault = new VaultWriter(tmp, "AIOS");
    vault.init();
    calls = [];
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function executor(run: (role: string, brief: string, opts: RunOptions) => Promise<SpecialistResult>) {
    return new PlaybookExecutor({
      run: async (role, brief, opts) => {
        calls.push({ role, brief });
        return run(role, brief, opts);
      },
      store,
      vault,
      wallTimeMs: 60_000,
    });
  }

  const ok = (text: string, structured?: unknown): SpecialistResult => ({
    text,
    structured,
    costUsd: 0,
    numTurns: 1,
  });

  it("runs single stages in order and accumulates context", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [
        { type: "single", id: "a", role: "researcher" },
        { type: "single", id: "b", role: "architect" },
      ],
    });
    const ctx = await executor(async (role) => ok(`${role}-out`)).execute(makeJob(), pb, "dir");
    expect(calls.map((c) => c.role)).toEqual(["researcher", "architect"]);
    // Stage b's brief contains stage a's artifact
    expect(calls[1].brief).toContain("researcher-out");
    expect(ctx.artifacts.map((a) => a.file)).toEqual(["a.md", "b.md"]);
    expect(vault.readJobArtifact("dir", "a.md")).toContain("researcher-out");
  });

  it("loop stage stops on approve and caps at maxRounds", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [{ type: "loop", id: "design", producer: "architect", critic: "reviewer", maxRounds: 3 }],
    });
    let round = 0;
    await executor(async (role) => {
      if (role === "architect") return ok(`design-v${++round}`);
      return ok("review", {
        verdict: round >= 2 ? "approve" : "revise",
        summary: "s",
        reasons: ["r1"],
      });
    }).execute(makeJob(), pb, "dir");

    // 2 producer rounds + 2 critic rounds, approved on round 2
    expect(calls.map((c) => c.role)).toEqual(["architect", "reviewer", "architect", "reviewer"]);
    // Round-2 producer brief carries round-1 feedback
    expect(calls[2].brief).toContain("Reviewer feedback");
    expect(vault.readJobArtifact("dir", "design.md")).toContain("design-v2");
    expect(vault.readJobArtifact("dir", "design.md")).not.toContain("Loop cap reached");
  });

  it("loop proceeds with warning when never approved", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [{ type: "loop", id: "design", producer: "architect", critic: "reviewer", maxRounds: 2 }],
    });
    await executor(async (role) =>
      role === "architect"
        ? ok("design")
        : ok("review", { verdict: "revise", summary: "bad", reasons: ["r"] }),
    ).execute(makeJob(), pb, "dir");
    expect(calls.filter((c) => c.role === "architect")).toHaveLength(2);
    expect(vault.readJobArtifact("dir", "design.md")).toContain("Loop cap reached");
  });

  it("verify stage sends failures to fixer then re-runs", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [{ type: "verify", id: "test", runner: "tester", fixer: "developer", maxRounds: 2 }],
    });
    let testRuns = 0;
    await executor(async (role) => {
      if (role === "tester") {
        testRuns++;
        return ok("report", {
          passed: testRuns >= 2,
          summary: testRuns >= 2 ? "all green" : "1 failing",
          failures: testRuns >= 2 ? [] : ["test_x fails"],
        });
      }
      return ok("fixed it");
    }).execute(makeJob(), pb, "dir");

    expect(calls.map((c) => c.role)).toEqual(["tester", "developer", "tester"]);
    expect(calls[1].brief).toContain("test_x fails");
    expect(vault.readJobArtifact("dir", "test.md")).toContain("all green");
  });

  it("retries a failed stage once, then fails the job", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [{ type: "single", id: "a", role: "researcher" }],
    });
    let attempts = 0;
    await expect(
      executor(async () => {
        attempts++;
        throw new Error("boom");
      }).execute(makeJob(), pb, "dir"),
    ).rejects.toThrow("boom");
    expect(attempts).toBe(2);
  });

  it("resumes from last completed stage", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [
        { type: "single", id: "a", role: "researcher" },
        { type: "single", id: "b", role: "architect" },
      ],
    });
    const job = makeJob();
    // First run: stage a succeeds, stage b fails twice.
    let failB = true;
    const exec = executor(async (role) => {
      if (role === "architect" && failB) throw new Error("flaky");
      return ok(`${role}-out`);
    });
    await expect(exec.execute(job, pb, "dir")).rejects.toThrow("flaky");
    expect(calls.filter((c) => c.role === "researcher")).toHaveLength(1);

    // Second run: stage a skipped, stage b runs; its brief still has a's artifact.
    failB = false;
    calls.length = 0;
    await exec.execute(job, pb, "dir");
    expect(calls.map((c) => c.role)).toEqual(["architect"]);
    expect(calls[0].brief).toContain("researcher-out");
  });

  it("aborts when wall-time budget exhausted", async () => {
    const pb: Playbook = playbookSchema.parse({
      name: "pb",
      description: "d",
      stages: [{ type: "single", id: "a", role: "researcher" }],
    });
    const exec = new PlaybookExecutor({
      run: async () => ok("x"),
      store,
      vault,
      wallTimeMs: -1,
    });
    await expect(exec.execute(makeJob(), pb, "dir")).rejects.toThrow(/wall-time/i);
  });
});
