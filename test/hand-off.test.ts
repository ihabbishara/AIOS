import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { attachBudgetLedger } from "../src/engine/budget.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { testRegistry } from "./fixtures/registry.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import { loadConfig } from "../src/config.js";
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
// Capability surface pins — every seam resolves through resolveAgent (org-model
// spec §7), so "parity" is structural; these pin the deny-row + resolution paths.
// ---------------------------------------------------------------------------

describe("capability parity", () => {
  function resolver() {
    const reg = testRegistry();
    const deps = makeDeps();
    const resolveAgent = makeResolveAgent({
      registry: reg, store: deps.store, vault: deps.vault, gate: deps.gate,
      config: loadConfig(process.cwd()), categorize: async () => "other" as const,
    });
    return { reg, deps, resolveAgent };
  }
  const origin = { channel: "cli", chatId: "x" };

  it("every agent resolves; alias and canonical name yield the same surface", () => {
    const { reg, resolveAgent } = resolver();
    for (const [name, def] of reg.agents) {
      const byName = resolveAgent(name, origin, { cwd: "/tmp" })!;
      expect(byName, name).toBeTruthy();
      const alias = def.manifest.aliases[0];
      if (!alias) continue;
      const byAlias = resolveAgent(alias, origin, { cwd: "/tmp" })!;
      expect([...(byAlias.options.allowedTools ?? [])].sort(), `${name} via @${alias}`)
        .toEqual([...(byName.options.allowedTools ?? [])].sort());
    }
  });

  it("a role_permission deny row is honoured by the resolution path", () => {
    const { reg, deps, resolveAgent } = resolver();
    const entry = [...reg.agents].find(([, d]) => (d.role.allowedTools?.length ?? 0) > 0)!;
    const [name, def] = entry;
    const tool = def.role.allowedTools![0];
    deps.store.setRolePermission(name, tool, 0, "test");
    expect(resolveAgent(name, origin, { cwd: "/tmp" })!.options.allowedTools).not.toContain(tool);
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
    memory: { halfLifeDays: 90, stalePenalty: 0.7 },
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
      runSpecialist,
      bus,
      primaryChat,
      projectsRoot: "/tmp",
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

// ---------------------------------------------------------------------------
// A hand-off is a full LLM turn by a SECOND agent. The chief of staff's own
// agent.end (router.ts) carries only its own cost, so an unbilled hand-off is
// spend attributed to nobody.
// ---------------------------------------------------------------------------

describe("hand_off billing (makeHandOff)", () => {
  const PRIMARY = { channel: "tg", chatId: "private-1" };
  const GROUP = { channel: "tg", chatId: "group-9" };

  function setup(opts: { costUsd?: number; throws?: boolean } = {}) {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const events: import("../src/events.js").AiosEvent[] = [];
    bus.on((e) => events.push(e.event));
    const handOff = makeHandOff({
      registry: testRegistry(),
      runSpecialist: async (agent: string) => {
        if (opts.throws) throw new Error("provider down");
        return { text: `ran ${agent}`, costUsd: opts.costUsd ?? 0.42, numTurns: 3 };
      },
      bus,
      primaryChat: PRIMARY,
      projectsRoot: "/tmp",
    });
    const runEvents = () => events.filter((e) => e.type === "agent.start" || e.type === "agent.end");
    return { handOff, store, bus, events, runEvents };
  }

  it("bills the handed-off turn with a paired agent.start/agent.end", async () => {
    const { handOff, runEvents } = setup();
    await handOff("maya", "fix", GROUP);
    expect(runEvents()).toEqual([
      { type: "agent.start", agent: "vulcan", context: "chat:tg:group-9" },
      { type: "agent.end", agent: "vulcan", context: "chat:tg:group-9", ok: true, costUsd: 0.42, turns: 3 },
    ]);
  });

  it("bills the CANONICAL agent, not the alias the chief of staff typed", async () => {
    const { handOff, runEvents } = setup();
    await handOff("cfo", "spend", PRIMARY); // cfo is an alias of midas
    // Per-agent aggregates fold aliases, but the ledger writes whatever name it is handed —
    // emitting "cfo" here would misfile the spend onto a name not in the roster.
    expect(runEvents().map((e) => e.agent)).toEqual(["midas", "midas"]);
  });

  it("the billed turn reaches the daily ledger and the per-agent rollup", async () => {
    const { handOff, store, bus } = setup({ costUsd: 0.42 });
    attachBudgetLedger(bus, store, () => "2026-08-10");
    await handOff("maya", "fix", GROUP);
    expect(store.budgetSpentCents("2026-08-10")).toBe(42);
    expect(store.costsByAgent("2026-08-10")).toEqual([
      { agent: "vulcan", usd_cents: 42, runs: 1, last_date: "2026-08-10" },
    ]);
  });

  it("a refused private hand-off bills nothing — the specialist never ran", async () => {
    const { handOff, runEvents } = setup();
    await handOff("faris", "spend", GROUP);
    expect(runEvents()).toEqual([]);
  });

  it("a failed hand-off still ends the run — no orphan start, nothing billed", async () => {
    const { handOff, runEvents } = setup({ throws: true });
    await expect(handOff("maya", "fix", GROUP)).rejects.toThrow(/provider down/);
    // An unpaired start leaves the agent stuck "working" forever in the org view.
    expect(runEvents()).toEqual([
      { type: "agent.start", agent: "vulcan", context: "chat:tg:group-9" },
      { type: "agent.end", agent: "vulcan", context: "chat:tg:group-9", ok: false },
    ]);
  });
});
