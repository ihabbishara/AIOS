// test/org-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildOrgView, buildAgentProfile } from "../src/web/org-view.js";

/** Minimal two-department registry: engineering (vulcan, alias developer) + finance (midas, private). */
export function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "org-"));
  const agentsDir = join(root, "agents");
  const playbooksDir = join(root, "playbooks");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(playbooksDir, { recursive: true });
  writeFileSync(join(agentsDir, "_capabilities.yaml"),
    "files-basic: { tools: [Read, Edit, Write] }\nvw: { actions: [vault.write] }\n");
  writeFileSync(join(eng, "department.yaml"),
    `department: engineering\nmission: Build software safely.\nlead: athena\nmemoDomain: code\nsandbox: true\ncapabilities: [files-basic, vw]\nplaybooks: []\n`);
  writeFileSync(join(eng, "vulcan.yaml"),
    // vulcan doubles as the fixture's kind: coordinator (loader v2 requires exactly one at boot)
    `name: vulcan\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns implementing code changes.\npersona: Terse.\nprompt: You are vulcan.\ntools: [Read, Edit, Write]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\nkind: coordinator\n`);
  writeFileSync(join(fin, "department.yaml"),
    `department: finance\nmission: Money visibility.\nmemoDomain: money\nactions: []\nplaybooks: []\nprivateMemo: true\n`);
  writeFileSync(join(fin, "midas.yaml"),
    `name: midas\ntitle: CFO\ndepartment: finance\ncharter: Watches the money.\npersona: Discreet.\nprompt: You are the CFO.\ntools: []\nmaxTurns: 20\nvisibility: private\naliases: [cfo]\n`);
  return loadRegistry(agentsDir, playbooksDir);
}

function pendingAction(channel: string, chatId: string) {
  return {
    id: "act-1", type: "vault.write", payload: "{}", preview: "write a note",
    status: "proposed" as const, origin_channel: channel, origin_chat_id: chatId,
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: new Date().toISOString(), resolved_at: null,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function harness() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  return { store, bus, registry: fixtureRegistry() };
}

describe("buildOrgView", () => {
  it("lists departments with their agents, idle by default", () => {
    const { store, bus, registry } = harness();
    const org = buildOrgView(registry, store, bus);
    const eng = org.find((d) => d.department === "engineering")!;
    expect(eng.mission).toBe("Build software safely.");
    expect(eng.lead).toBe("athena");
    expect(eng.agents.map((a) => a.name)).toEqual(["vulcan"]);
    expect(eng.agents[0]).toMatchObject({
      title: "Senior Engineer", status: "idle", currentTask: null, costTodayUsd: 0,
      visibility: "shared", guarded: false,
    });
    const fin = org.find((d) => d.department === "finance")!;
    expect(fin.agents[0]).toMatchObject({ name: "midas", visibility: "private" });
  });

  it("agent.start marks working — alias names canonicalize", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "developer", context: "chat:telegram:42" });
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("working");
    expect(eng.agents[0].currentTask).toBe("chat:telegram:42");
  });

  it("working + pending action from the same chat origin = waiting", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    store.insertAction(pendingAction("telegram", "42"));
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("waiting");
  });

  it("pending action from a different origin does NOT mark waiting", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    store.insertAction(pendingAction("telegram", "999"));
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("working");
  });

  it("agent.end returns to idle; today's cost reads the rollup, alias rows canonicalized", () => {
    const { store, bus, registry } = harness();
    const today = new Date().toISOString().slice(0, 10);
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.25 });
    // rollup rows as the ledger listener writes them — raw router names, aliases included
    store.costAdd("vulcan", today, 25);
    store.costAdd("developer", today, 50);
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("idle");
    expect(eng.agents[0].costTodayUsd).toBeCloseTo(0.75);
  });

  it("cost from before the requested day is excluded", () => {
    const { store, bus, registry } = harness();
    store.costAdd("vulcan", "1998-12-30", 25);
    const eng = buildOrgView(registry, store, bus, "1999-01-01").find((d) => d.department === "engineering")!;
    expect(eng.agents[0].costTodayUsd).toBe(0);
  });
});

describe("buildAgentProfile", () => {
  it("returns null for unknown agents", () => {
    const { store, bus, registry } = harness();
    expect(buildAgentProfile("nobody", registry, store, bus)).toBeNull();
  });

  it("resolves aliases to the canonical profile", () => {
    const { store, bus, registry } = harness();
    const p = buildAgentProfile("developer", registry, store, bus)!;
    expect(p.name).toBe("vulcan");
    expect(p.title).toBe("Senior Engineer");
    expect(p.department).toBe("engineering");
    expect(p.charter).toBe("Owns implementing code changes.");
    expect(p.persona).toBe("Terse.");
    expect(p.aliases).toEqual(["developer"]);
  });

  it("effective tools tag grants; revoked defaults listed separately", () => {
    const { store, bus, registry } = harness();
    store.setRolePermission("vulcan", "WebSearch", 1, "test");
    store.setRolePermission("vulcan", "Write", 0, "test");
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.tools).toContainEqual({ name: "WebSearch", source: "granted" });
    expect(p.tools).toContainEqual({ name: "Read", source: "default" });
    expect(p.tools.some((t) => t.name === "Write")).toBe(false);
    expect(p.revoked).toEqual([{ name: "Write", source: "revoked" }]);
  });

  it("grantable offers every known tool the agent lacks, tagged with its source", () => {
    const { store, bus, registry } = harness();
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    const names = p.grantable.map((g) => g.name);
    // builtins the agent does not already carry are offered...
    expect(names).toContain("WebSearch");
    expect(p.grantable.find((g) => g.name === "WebSearch")!.from).toBe("builtin");
    // ...capability tools from OTHER capabilities too, tagged with the capability
    expect(names).toContain("Bash");
    // ...but never a tool it already has
    expect(names).not.toContain("Read");
    expect(names).not.toContain("Edit");
    // sorted and unique — it feeds a datalist
    expect(names).toEqual([...new Set(names)].sort());
  });

  it("grantable re-offers a revoked default and drops a granted extra", () => {
    const { store, bus, registry } = harness();
    store.setRolePermission("vulcan", "Write", 0, "test");   // revoked → grantable again
    store.setRolePermission("vulcan", "WebSearch", 1, "test"); // granted → no longer offered
    const names = buildAgentProfile("vulcan", registry, store, bus)!.grantable.map((g) => g.name);
    expect(names).toContain("Write");
    expect(names).not.toContain("WebSearch");
  });

  it("trust rows filter to the department's action ceiling", () => {
    const { store, bus, registry } = harness();
    const trustRow = (actionType: string) => ({
      actionType, state: "supervised" as const, approvals: 1, rejections: 0, streak: 1, shadowMatches: 0,
      firstSeen: new Date().toISOString(), lastRejection: null, graduatedAt: null,
    });
    store.upsertTrust(trustRow("vault.write"));
    store.upsertTrust(trustRow("email.send"));
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.trust.map((t) => t.actionType)).toEqual(["vault.write"]);
  });

  it("recent runs and handoffs come from the event stream; cost history from the rollup", () => {
    const { store, bus, registry } = harness();
    store.costAdd("vulcan", new Date().toISOString().slice(0, 10), 30);
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.3 });
    bus.emit({ type: "agent.end", agent: "developer", context: "job:fix-auth/implement", ok: false });
    bus.emit({
      type: "route.decision", to: "vulcan", via: "handoff",
      reason: "charter match — code change", channel: "telegram", chatId: "42",
    });
    bus.emit({
      type: "route.decision", to: "vulcan", via: "mention",
      reason: "direct mention", channel: "telegram", chatId: "42",
    });
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.recentRuns).toHaveLength(2);
    expect(p.recentRuns[0]).toMatchObject({ context: "job:fix-auth/implement", ok: false }); // newest first
    expect(p.handoffs).toHaveLength(1); // via=handoff only
    expect(p.handoffs[0].reason).toBe("charter match — code change");
    expect(Object.values(p.costByDay)).toEqual([0.3]);
  });

  it("exposes kind, capabilities, and the system prompt", () => {
    const { store, bus, registry } = harness();
    const p = buildAgentProfile("vulcan", registry, store, bus)!;
    expect(p.kind).toBe("coordinator");
    expect(p.capabilities).toEqual(["files-basic", "vw"]);
    expect(p.prompt).toBe("You are vulcan.");
  });
});
