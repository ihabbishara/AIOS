// test/org-view.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildOrgView } from "../src/web/org-view.js";

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
  writeFileSync(join(eng, "department.yaml"),
    `department: engineering\nmission: Build software safely.\nlead: athena\nmemoDomain: code\nsandbox: true\nactions: [vault.write]\nplaybooks: []\n`);
  writeFileSync(join(eng, "vulcan.yaml"),
    `name: vulcan\ntitle: Senior Engineer\ndepartment: engineering\ncharter: Owns implementing code changes.\npersona: Terse.\nprompt: You are vulcan.\ntools: [Read, Edit, Write]\npermissionMode: bypassPermissions\nmaxTurns: 80\naliases: [developer]\n`);
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

  it("agent.end returns to idle and sums today's cost", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.start", agent: "vulcan", context: "chat:telegram:42" });
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.25 });
    bus.emit({ type: "agent.start", agent: "developer", context: "chat:web:ui" });
    bus.emit({ type: "agent.end", agent: "developer", context: "chat:web:ui", ok: true, costUsd: 0.5 });
    const eng = buildOrgView(registry, store, bus).find((d) => d.department === "engineering")!;
    expect(eng.agents[0].status).toBe("idle");
    expect(eng.agents[0].costTodayUsd).toBeCloseTo(0.75);
  });

  it("cost from another day is excluded", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.end", agent: "vulcan", context: "chat:telegram:42", ok: true, costUsd: 0.25 });
    const eng = buildOrgView(registry, store, bus, "1999-01-01").find((d) => d.department === "engineering")!;
    expect(eng.agents[0].costTodayUsd).toBe(0);
  });
});
