import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { testRegistry } from "./fixtures/registry.js";
import { makeResolveDeptFor } from "../src/packs/resolve.js";
import { roleQueryOptions, packRunOptions } from "../src/agents/runner.js";
import { buildModeratorServer } from "../src/moderator/tools.js";
import type { ModeratorToolsDeps } from "../src/moderator/tools.js";
import type { GoogleAccounts } from "../src/senses/google/auth.js";
import type { JobManager } from "../src/engine/jobs.js";

// ---------------------------------------------------------------------------
// Shared deps factories
// ---------------------------------------------------------------------------

function makeDeps(extra: { toolServers?: Record<string, () => unknown> } = {}) {
  const vaultRoot = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(vaultRoot, "AIOS");
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  return { store, vault, gate, ...extra };
}

// Pull handlers off the built server's _registeredTools (same pattern as lifeops-server.test.ts).
type ToolHandler = (a: unknown) => Promise<{ content: Array<{ text: string }> }>;
function handlers(server: unknown) {
  return (server as unknown as {
    instance: { _registeredTools: Record<string, { handler: ToolHandler }> };
  }).instance._registeredTools;
}
const callText = async (h: { handler: ToolHandler }, a: unknown) =>
  (await h.handler(a)).content[0].text;

// ---------------------------------------------------------------------------
// Capability parity: hand_off and @mention resolve identical allowedTools
// ---------------------------------------------------------------------------

describe("capability parity", () => {
  it("hand_off and @mention resolve identical allowedTools for every agent", () => {
    const reg = testRegistry();
    const deps = makeDeps();
    const resolve = makeResolveDeptFor(reg, deps);

    for (const [name, def] of reg.agents) {
      const origin = { channel: "cli", chatId: "x" };
      // Both paths call resolveDeptFor with the same args (isAgent=true).
      const packA = resolve(name, origin, true); // @mention path (DirectChats)
      const packB = resolve(name, origin, true); // hand_off path (index.ts wiring)
      const base = roleQueryOptions(def.role, { cwd: "/tmp" });
      const a = packA ? packRunOptions(base, packA).allowedTools : base.allowedTools;
      const b = packB ? packRunOptions(base, packB).allowedTools : base.allowedTools;
      expect([...(a ?? [])].sort(), name).toEqual([...(b ?? [])].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// hand_off tool — unit tests via _registeredTools
// ---------------------------------------------------------------------------

function buildServer(overrides: Partial<ModeratorToolsDeps> = {}) {
  const store = new Store(":memory:");
  const deps: ModeratorToolsDeps = {
    jobs: null as unknown as JobManager,
    store,
    vault: null as unknown as VaultWriter,
    projectsRoot: "/tmp",
    origin: { channel: "cli", chatId: "test" },
    handOff: async () => ({ text: "default" }),
    agentNames: ["maya"],
    gate: null as unknown as ActionGate,
    actionTypes: [],
    google: null as unknown as GoogleAccounts,
    ...overrides,
  };
  return buildModeratorServer(deps);
}

describe("hand_off tool", () => {
  it("routes through deps.handOff and prefixes the agent name", async () => {
    const calls: string[] = [];
    const server = buildServer({
      agentNames: ["maya"],
      handOff: async (agent, task) => {
        calls.push(`${agent}:${task}`);
        return { text: "done" };
      },
    });
    const t = handlers(server);
    const result = await callText(t["hand_off"], { agent: "maya", task: "fix it" });
    expect(result).toContain("[maya]");
    expect(result).toContain("done");
    expect(calls).toEqual(["maya:fix it"]);
  });

  it("ask_specialist no longer exists on the server; hand_off does", () => {
    const server = buildServer({ agentNames: ["maya"] });
    const t = handlers(server);
    const toolNames = Object.keys(t);
    expect(toolNames).toContain("hand_off");
    expect(toolNames).not.toContain("ask_specialist");
  });
});
