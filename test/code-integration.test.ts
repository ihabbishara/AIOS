// test/code-integration.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type GoalRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { GoalEngine } from "../src/engine/goals.js";
import { SpendGuard } from "../src/engine/budget.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { allocateWorkspace } from "../src/code/workspace.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";

describe("code-analyze end-to-end (stubbed model)", () => {
  it("allocates analyze workspace = source, writes a vault report, never writes the repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-"));
    const projects = join(home, "projects");
    const repo = join(projects, "target");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "i"], { cwd: repo });
    writeFileSync(join(repo, "main.ts"), "export const x = 1;\n");
    // realRepo: macOS /var is a symlink to /private/var; resolveReal() inside allocateWorkspace
    // calls realpathSync, so taskDir is the canonical /private/var/... path. Resolve here
    // so our assertions compare the same canonical path.
    const realRepo = realpathSync(repo);
    const repoFilesBefore = readdirSync(realRepo).sort();

    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "vault-")), "AIOS");
    vault.init();
    const reg = loadRegistry(join(process.cwd(), "agents"), join(process.cwd(), "playbooks"));

    const bus = new EventBus(store);
    const registry = new ExecutorRegistry();
    const gate = new ActionGate({
      store, registry, policy: DEFAULT_POLICY, bus, expiryMs: 60_000,
    });

    // stub specialist: capture opts, but assert AFTER the job is done (below). An inline
    // expect() here would throw → the executor catches it → the job goes "failed" → the
    // vi.waitFor(status==="done") times out with a confusing message instead of a precise
    // "expected X to be Y". Capturing keeps the wiring-regression failure legible.
    let capturedOpts: any;
    const run = vi.fn(async (_role: string, _brief: string, opts: any) => {
      capturedOpts = opts;
      return { text: "assessment ok", costUsd: 0, numTurns: 1 };
    });

    const goals = new GoalEngine({
      store, vault, run: run as never, playbooks: reg.playbooks, wallTimeMs: 60_000, maxConcurrentNodes: 1, mailMaxDepth: 2,
      spendGuard: new SpendGuard({ store }),
      onComplete: async () => {},
      registry: reg,
      prepareSandbox: async (goal: GoalRow) => {
        if (goal.department !== "engineering") return undefined;
        const { taskDir } = allocateWorkspace(
          { mode: "analyze", source: goal.project_dir ?? undefined, slug: goal.slug },
          { workspaceRoot: join(home, "ws"), readRoots: [projects], now: "2026-06-21", id: "deadbeef" },
        );
        return { taskDir, mode: "analyze" as const };
      },
    });

    const job = goals.createFromPlaybook({
      playbook: "code-analyze", title: "audit target", request: "assess this repo",
      projectDir: repo, channel: "system", chatId: "test",
    });

    await vi.waitFor(() => expect(store.getGoal(job.id)!.status).toBe("done"), { timeout: 10_000 });

    // Wiring asserts surfaced after the job is done → clear messages, no timeout-masking.
    expect(run).toHaveBeenCalled();
    expect(capturedOpts.cwd).toBe(realRepo); // analyze → taskDir = resolveReal(source)
    // Confinement now derives from the workspace INSIDE resolveAgent (runner-internal) —
    // the engine's contract is threading the workspace through RunOptions.
    expect(capturedOpts.workspace?.taskDir).toBe(realRepo);
    expect(capturedOpts.workspace?.mode).toBe("analyze");
    expect(store.getGoal(job.id)!.project_dir).toBe(realRepo); // rewritten to analyze taskDir = resolveReal(source)
    expect(readdirSync(realRepo).sort()).toEqual(repoFilesBefore); // analyzed repo untouched
  }, 15_000);
});
