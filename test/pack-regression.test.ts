import { describe, it, expect } from "vitest";
import { PlaybookExecutor } from "../src/engine/executor.js";
import type { Playbook } from "../src/engine/playbook.js";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const playbook: Playbook = {
  name: "p", description: "d", needsProjectDir: false,
  stages: [{ type: "single", id: "s1", role: "researcher" }],
};

function harness(pack?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const seen: Array<Record<string, unknown>> = [];
  const run = async (_role: string, _brief: string, opts: Record<string, unknown>) => {
    seen.push(opts);
    return { text: "ok", costUsd: 0, numTurns: 1 };
  };
  const exec = new PlaybookExecutor({ run: run as never, store, vault, wallTimeMs: 60000, pack: pack as never });
  return { root, store, vault, exec, seen };
}

describe("executor pack threading", () => {
  it("packless job passes NO pack in run opts (zero regression)", async () => {
    const { root, store, exec, seen } = harness(undefined);
    store.insertJob({ id: "j1", slug: "p", title: "P", playbook: "p", request: "do", project_dir: null, channel: "cli", chat_id: "x", status: "queued", error: null });
    await exec.execute(store.getJob("j1")!, playbook, "2026-06-14-p");
    expect(seen[0].pack).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
  it("passes the resolved pack through to every run opts when set", async () => {
    const fakePack = { pillar: "money", contextBlock: "x", tools: [], mcpServers: {} };
    const { root, store, exec, seen } = harness(fakePack);
    store.insertJob({ id: "j2", slug: "p", title: "P", playbook: "p", request: "do", project_dir: null, channel: "cli", chat_id: "x", status: "queued", error: null });
    await exec.execute(store.getJob("j2")!, playbook, "2026-06-14-p2");
    expect(seen[0].pack).toBe(fakePack);
    rmSync(root, { recursive: true, force: true });
  });
});
