// test/standup.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { SpendGuard } from "../src/engine/budget.js";
import { activeDepartments, standupDigest, runStandups } from "../src/heartbeat/standup.js";
import type { SpecialistRunFn, RunOptions } from "../src/agents/runner.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "su-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\nkind: coordinator\n"); // fixture coordinator (loader v2)
  writeFileSync(join(eng, "vulcan.yaml"),
    "name: vulcan\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const SINCE = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function goalRow(store: Store, over: Record<string, unknown> = {}) {
  store.insertGoal({
    id: (over.id as string) ?? "g1", slug: "x", title: (over.title as string) ?? "Build X", request: "x",
    department: (over.department as string) ?? "engineering", lead: "athena",
    origin_channel: "telegram", origin_chat_id: "1", status: (over.status as never) ?? "done",
    project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0,
    error: (over.error as string | null) ?? null, chain_depth: 0,
  });
}

describe("activeDepartments", () => {
  it("goal activity OR member mail marks a dept active; finance (privateMemo) always excluded", () => {
    const store = new Store(":memory:");
    expect(activeDepartments(store, registry, SINCE)).toEqual([]);
    goalRow(store);
    expect(activeDepartments(store, registry, SINCE)).toEqual(["engineering"]);
    // finance goal exists but privateMemo excludes the dept
    goalRow(store, { id: "g2", department: "finance" });
    expect(activeDepartments(store, registry, SINCE)).toEqual(["engineering"]);
  });

  it("mail from a member activates; old activity does not", () => {
    const store = new Store(":memory:");
    store.insertMail({
      id: "m1", from_agent: "vulcan", to_agent: "athena", kind: "note", body: "x", goal_id: null,
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    expect(activeDepartments(store, registry, SINCE)).toEqual(["engineering"]);
    expect(activeDepartments(store, registry, new Date(Date.now() + 1000).toISOString())).toEqual([]);
  });
});

describe("activity window (M7)", () => {
  it("a weeks-old goal resumed recently still activates its department", () => {
    const store = new Store(":memory:");
    // 101 goals: g0 is the OLDEST-created but the only recently-updated one.
    for (let i = 0; i <= 100; i++) {
      goalRow(store, { id: `g${i}`, title: `G${i}`, department: "engineering", status: "done" });
    }
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const old = new Date(Date.now() - 30 * 864e5).toISOString();
    // Everything is stale (updated long ago); g1..g100 keep their fresh created_at.
    db.prepare("UPDATE goals SET updated_at = ?").run(old);
    // g0 is the OLDEST-created — the 100 newer goals push it out of the created_at LIMIT window...
    db.prepare("UPDATE goals SET created_at = ? WHERE id = 'g0'").run(old);
    // ...but it was just resumed: ancient created_at, fresh updated_at (a just-resumed parked goal).
    db.prepare("UPDATE goals SET updated_at = ? WHERE id = 'g0'").run(new Date().toISOString());

    const since = new Date(Date.now() - 864e5).toISOString();
    expect(activeDepartments(store, registry, since)).toContain("engineering");
    expect(standupDigest(store, registry, "engineering", since)).toContain("G0");
  });
});

describe("standupDigest", () => {
  it("includes goal titles, statuses, costs, failures, mail counts", () => {
    const store = new Store(":memory:");
    goalRow(store);
    goalRow(store, { id: "g2", title: "Broken Y", status: "failed", error: "exploded badly" });
    store.insertNodes("g1", [{ node_key: "a", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 }]);
    store.addNodeCost("g1", "a", 92);
    store.insertMail({
      id: "m1", from_agent: "vulcan", to_agent: "athena", kind: "note", body: "x", goal_id: null,
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    const d = standupDigest(store, registry, "engineering", SINCE);
    expect(d).toContain("Build X");
    expect(d).toContain("$0.92");
    expect(d).toContain("Broken Y");
    expect(d).toContain("exploded badly");
    expect(d).toContain("mail sent: 1");
  });
});

describe("runStandups", () => {
  it("runs the lead once per active dept and mails the standup to hermes", async () => {
    const store = new Store(":memory:");
    goalRow(store);
    const calls: string[] = [];
    const run: SpecialistRunFn = async (role, brief) => {
      calls.push(role);
      expect(brief).toContain("Build X");
      return { text: "done: X / today: Y / blockers: none", costUsd: 0.01, numTurns: 1 };
    };
    const n = await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store }) });
    expect(n).toBe(1);
    expect(calls).toEqual(["athena"]);
    const m = store.unreadMailFor("hermes")[0];
    expect(m).toMatchObject({ kind: "standup", from_agent: "athena" });
    expect(m.body).toContain("blockers: none");
  });

  it("standup one-shot does not drain the lead's inbox (no mailCtx)", async () => {
    const store = new Store(":memory:");
    goalRow(store);
    let captured: RunOptions | undefined;
    const run: SpecialistRunFn = async (_role, _brief, opts) => {
      captured = opts;
      return { text: "done: X / today: Y / blockers: none", costUsd: 0.01, numTurns: 1 };
    };
    await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store }) });
    expect(captured).toBeDefined();
    expect(captured!.mailCtx).toBeUndefined();
  });

  it("SpendGuard at cap skips; lead failure is contained", async () => {
    const store = new Store(":memory:");
    goalRow(store);
    store.budgetAdd(new Date().toISOString().slice(0, 10), 100);
    const run: SpecialistRunFn = async () => { throw new Error("nope"); };
    expect(await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store, capUsd: 1 }) })).toBe(0);
    expect(await runStandups({ store, registry, run, spendGuard: new SpendGuard({ store }) })).toBe(0); // failure contained
    expect(store.unreadMailFor("hermes")).toEqual([]);
  });
});
