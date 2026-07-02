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
import { roleQueryOptions, packRunOptions, specialistOptions } from "../src/agents/runner.js";
import { withEffectiveTools } from "../src/agents/permissions.js";
import { buildModeratorServer } from "../src/moderator/tools.js";
import { makeHandOff } from "../src/moderator/handoff.js";
import type { ModeratorToolsDeps } from "../src/moderator/tools.js";
import type { GoogleAccounts } from "../src/senses/google/auth.js";
import type { GoalEngine } from "../src/engine/goals.js";

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
//
// Two DISTINCT production paths are exercised:
//   Path A (@mention / DirectChats): roleQueryOptions → packRunOptions(pack?) → withEffectiveTools
//                                    (mirrors direct.ts handle() option assembly)
//   Path B (hand_off / makeRunSpecialist): specialistOptions() — the extracted kernel
//
// If either path drops the pack or skips withEffectiveTools the test will fail.
// ---------------------------------------------------------------------------

describe("capability parity", () => {
  it("hand_off and @mention resolve identical allowedTools for every agent", () => {
    const reg = testRegistry();
    const deps = makeDeps();
    const resolveDeptFor = makeResolveDeptFor(reg, deps);
    const origin = { channel: "cli", chatId: "x" };

    for (const [name, def] of reg.agents) {
      // Shared pack — same isAgent=true closure used by both paths in production.
      const pack = resolveDeptFor(name, origin, true);

      // Path A: DirectChats handle() option assembly (DIRECT_ADDENDUM is prompt-only; allowedTools unaffected).
      const baseA = roleQueryOptions(def.role, { cwd: "/tmp" });
      const withPackA = pack ? packRunOptions(baseA, pack) : baseA;
      const optionsA = withEffectiveTools(withPackA, name, deps.store);

      // Path B: specialist runner option assembly via the extracted pure kernel.
      const optionsB = specialistOptions(def.role, name, { cwd: "/tmp", pack }, deps.store);

      expect([...(optionsA.allowedTools ?? [])].sort(), `${name} allowedTools`).toEqual(
        [...(optionsB.allowedTools ?? [])].sort(),
      );
    }
  });

  it("a role_permission deny row is honoured by BOTH paths", () => {
    const reg = testRegistry();
    const deps = makeDeps();
    const resolveDeptFor = makeResolveDeptFor(reg, deps);
    const origin = { channel: "cli", chatId: "x" };

    // Pick the first agent that has at least one base allowedTool to revoke.
    const entry = [...reg.agents].find(([, d]) => (d.role.allowedTools?.length ?? 0) > 0);
    expect(entry, "test requires at least one agent with allowedTools").toBeDefined();
    const [name, def] = entry!;
    const tool = def.role.allowedTools![0];

    // Insert a deny row in the in-memory store — simulates a UI "revoke" action.
    deps.store.setRolePermission(name, tool, 0, "test");

    const pack = resolveDeptFor(name, origin, true);

    // Path A
    const baseA = roleQueryOptions(def.role, { cwd: "/tmp" });
    const withPackA = pack ? packRunOptions(baseA, pack) : baseA;
    const optionsA = withEffectiveTools(withPackA, name, deps.store);

    // Path B
    const optionsB = specialistOptions(def.role, name, { cwd: "/tmp", pack }, deps.store);

    expect(optionsA.allowedTools, `${name} Path A must drop ${tool}`).not.toContain(tool);
    expect(optionsB.allowedTools, `${name} Path B must drop ${tool}`).not.toContain(tool);
    // Parity holds even after a revoke.
    expect([...(optionsA.allowedTools ?? [])].sort()).toEqual([...(optionsB.allowedTools ?? [])].sort());
  });
});

// ---------------------------------------------------------------------------
// hand_off tool — unit tests via _registeredTools
// ---------------------------------------------------------------------------

function buildServer(overrides: Partial<ModeratorToolsDeps> = {}) {
  const store = new Store(":memory:");
  const deps: ModeratorToolsDeps = {
    goals: null as unknown as GoalEngine,
    departments: [],
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

// ---------------------------------------------------------------------------
// C1 — hand_off must enforce the privateOnly wall using the REAL per-turn origin.
// A group member must NOT reach a private agent (faris/jasmine) — and their full
// private tools — through the Chief of Staff's hand_off.
// ---------------------------------------------------------------------------

describe("hand_off privacy wall (makeHandOff)", () => {
  const PRIMARY = { channel: "tg", chatId: "private-1" };
  const GROUP = { channel: "tg", chatId: "group-9" };

  function setup(primaryChat?: { channel: string; chatId: string }) {
    const reg = testRegistry();
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const events: import("../src/events.js").StoredEvent[] = [];
    bus.on((e) => events.push(e));
    const calls: Array<{ agent: string; task: string }> = [];
    const runSpecialist = async (agent: string, task: string) => {
      calls.push({ agent, task });
      return { text: `ran ${agent}`, costUsd: 0, numTurns: 1 };
    };
    const handOff = makeHandOff({
      registry: reg,
      resolveDeptFor: () => undefined,
      runSpecialist,
      bus,
      primaryChat,
      projectsRoot: "/tmp",
      model: "m",
    });
    return { handOff, calls, events };
  }

  it("(a) refuses faris from a group origin and does NOT run the specialist", async () => {
    const { handOff, calls, events } = setup(PRIMARY);
    const res = await handOff("faris", "what did I spend", GROUP);
    expect(res.text).toMatch(/private/i);
    expect(calls).toHaveLength(0);
    const ev = events.find((e) => e.event.type === "route.decision")!.event as {
      reason: string; channel: string; chatId: string; via: string;
    };
    expect(ev.reason).toMatch(/refused/i);
    expect(ev.via).toBe("handoff");
    expect(ev.channel).toBe("tg");
    expect(ev.chatId).toBe("group-9");
  });

  it("(b) runs faris from the primary (private) origin", async () => {
    const { handOff, calls, events } = setup(PRIMARY);
    const res = await handOff("faris", "spend", PRIMARY);
    expect(calls).toEqual([{ agent: "faris", task: "spend" }]);
    expect(res.text).toContain("ran faris");
    const ev = events.find((e) => e.event.type === "route.decision")!.event as { reason: string };
    expect(ev.reason).not.toMatch(/refused/i);
  });

  it("(c) maya (shared) is unaffected from any origin", async () => {
    const { handOff, calls } = setup(PRIMARY);
    await handOff("maya", "fix", GROUP);
    expect(calls).toEqual([{ agent: "maya", task: "fix" }]);
  });

  it("(d) route.decision carries the real origin channel/chatId", async () => {
    const { handOff, events } = setup(PRIMARY);
    await handOff("maya", "fix", GROUP);
    const ev = events.find((e) => e.event.type === "route.decision")!.event as {
      channel: string; chatId: string; via: string;
    };
    expect(ev.via).toBe("handoff");
    expect(ev.channel).toBe("tg");
    expect(ev.chatId).toBe("group-9");
  });

  it("refuses faris addressed by its cfo alias from a group origin", async () => {
    const { handOff, calls } = setup(PRIMARY);
    const res = await handOff("cfo", "spend", GROUP);
    expect(res.text).toMatch(/private/i);
    expect(calls).toHaveLength(0);
  });
});
