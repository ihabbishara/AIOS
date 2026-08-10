// test/runner-provider-error.test.ts — the guard where it actually matters.
//
// isProviderError is unit-tested separately; this proves it is WIRED, i.e. that a specialist
// run whose provider returned an outage-as-success throws instead of handing the outage back
// as the answer. Without the wiring the unit test is decoration: on 2026-08-05 the outage
// text reached ten node artifacts and six nodes were marked `done`.
import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { makeRunSpecialist } from "../src/agents/runner.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rpe-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\nkind: coordinator\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

function runnerYielding(result: string) {
  const store = new Store(":memory:");
  const registry = fixture();
  const def = registry.agents.get("athena")!;
  vi.mocked(query).mockReturnValueOnce((async function* () {
    yield { type: "result", subtype: "success", session_id: "s1", result, total_cost_usd: 0.2, num_turns: 1 };
  })() as never);
  return makeRunSpecialist({
    store, bus: new EventBus(store), registry,
    // Real AgentDef from the fixture — the runner reaches into it for the role surface.
    resolveAgent: () => ({
      canonical: "athena", kind: def.kind, def,
      options: { allowedTools: [] }, ceiling: [], labels: [], personaSurface: "",
    }) as never,
  });
}

describe("specialist runs and provider outages", () => {
  it("throws when the provider returns its quota error AS a successful result", async () => {
    // The exact 2026-08-05 payload: subtype "success", body = the outage sentence.
    const run = runnerYielding("You've hit your weekly limit · resets Aug 10 at 3am (Europe/Paris)");
    await expect(run("athena", "write the report", { cwd: process.cwd() }))
      .rejects.toThrow(/provider error instead of output/);
  });

  it("still returns real work untouched", async () => {
    const run = runnerYielding("# Report\n\nThe answer is 42.");
    const res = await run("athena", "write the report", { cwd: process.cwd() });
    expect(res.text).toContain("The answer is 42.");
    expect(res.costUsd).toBe(0.2);
  });
});
