// test/attention-view.test.ts
import { describe, it, expect } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Store, type GoalRow } from "../src/store/db.js";
import type { ActionRow } from "../src/kernel/actions.js";
import { buildAttentionView } from "../src/web/attention-view.js";
import { buildGoalsView } from "../src/web/goals-view.js";
import { startWebServer, type WebDeps } from "../src/web/server.js";

const NOW = () => new Date("2026-07-13T10:00:00.000Z");

function action(id: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "test.echo", payload: "{}", preview: `preview ${id}`,
    status: "proposed", origin_channel: "cli", origin_chat_id: "local",
    trust_state: "supervised", verdict_by: null, reject_reason: null, result: null,
    created_at: "2026-07-13T09:00:00.000Z", resolved_at: null,
    expires_at: "2026-07-14T09:00:00.000Z", ...over,
  };
}

function goal(id: string, over: Partial<GoalRow> = {}): Omit<GoalRow, "created_at" | "updated_at" | "spawned_by_mail"> {
  return {
    id, slug: id, title: `goal ${id}`, request: "r", department: "research", lead: "iris",
    origin_channel: "web", origin_chat_id: "ui", status: "running",
    project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0,
    chain_depth: 0, error: null, ...over,
  };
}

function ask(store: Store, id: string, from: string, body: string, goalId: string | null = null) {
  store.insertMail({
    id, from_agent: from, to_agent: "user", kind: "request", body,
    goal_id: goalId, origin_channel: "engine", origin_chat_id: "x",
    chain_depth: 0, status: "awaiting-human", error: null,
  });
}

describe("buildAttentionView", () => {
  it("ranks approvals > asks > goals > mail > senses, ts-desc within a rank", () => {
    const store = new Store(":memory:");
    store.insertAction(action("a1"));
    ask(store, "m1", "iris", "Which account?", "g-ask");
    store.insertGoal(goal("g1"));
    store.updateGoalStatus("g1", "failed", "boom");
    store.insertMail({
      id: "n1", from_agent: "neo", to_agent: "user", kind: "note", body: "FYI note",
      goal_id: null, origin_channel: "engine", origin_chat_id: "x",
      chain_depth: 0, status: "unread", error: null,
    });
    const senses = () => [{ name: "google:personal", ok: false, reason: "invalid_grant" }];
    const items = buildAttentionView(store, senses, NOW);
    expect(items.map((i) => i.kind)).toEqual(["approval", "ask", "goal", "mail", "sense"]);
    expect(items.map((i) => i.severity)).toEqual([1, 2, 3, 4, 5]);
    expect(items[0].actions).toEqual(["approve", "reject", "open"]);
    expect(items[1].actions).toEqual(["answer", "open"]);
    expect(items[1].ref.goalId).toBe("g-ask");
    expect(items[2].actions).toContain("abandon");
    expect(items[4].meta).toBe("invalid_grant");
  });

  it("excludes expired approvals, answered asks, old failures, read mail, healthy senses", () => {
    const store = new Store(":memory:");
    store.insertAction(action("dead", { expires_at: "2026-07-13T09:59:00.000Z" }));
    ask(store, "m2", "iris", "answered ask");
    store.insertMail({
      id: "r2", from_agent: "user", to_agent: "iris", kind: "report", body: "answer",
      goal_id: null, origin_channel: "web", origin_chat_id: "ui",
      chain_depth: 0, status: "read", error: null, in_reply_to: "m2",
    });
    store.insertGoal(goal("gOld"));
    store.updateGoalStatus("gOld", "failed", "old");
    const future = () => new Date(Date.now() + 72 * 3_600_000); // 48h window has passed
    const senses = () => [{ name: "gmail", ok: true }];
    expect(buildAttentionView(store, senses, future)).toEqual([]);
  });

  it("surfaces paused-budget, paused-user and paused-session goals regardless of age", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gb"));
    store.updateGoalStatus("gb", "paused-budget");
    store.insertGoal(goal("gu"));
    store.updateGoalStatus("gu", "paused-user");
    store.insertGoal(goal("gs"));
    store.updateGoalStatus("gs", "paused-session");
    const future = () => new Date(Date.now() + 72 * 3_600_000);
    const items = buildAttentionView(store, undefined, future);
    expect(items.map((i) => i.ref.status).sort()).toEqual(["paused-budget", "paused-session", "paused-user"]);
    expect(items.every((i) => i.actions.includes("resume"))).toBe(true);
  });

  it("failed goals offer reopen (⑮ resurrection, surfaced in the inbox — cycle ⑱)", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gr"));
    store.updateGoalStatus("gr", "failed", "boom");
    const items = buildAttentionView(store, undefined, NOW);
    const g = items.find((i) => i.kind === "goal")!;
    expect(g.actions).toEqual(["open", "reopen", "abandon"]);
    expect(g.ref.goalId).toBe("gr");
  });

  it("skips legacy goals and threads whose only flag is a pending ask (ranked higher already)", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("gl"));
    store.updateGoalStatus("gl", "failed", "x");
    store.freezeLegacyGoals();
    ask(store, "m3", "iris", "only an ask in this thread");
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.filter((i) => i.kind === "goal")).toEqual([]);
    expect(items.filter((i) => i.kind === "mail")).toEqual([]); // ask thread not double-listed
    expect(items.filter((i) => i.kind === "ask")).toHaveLength(1);
  });
});

describe("GoalView.originChannel", () => {
  it("maps goals.origin_channel", () => {
    const store = new Store(":memory:");
    store.insertGoal(goal("g2", { origin_channel: "mail" }));
    expect(buildGoalsView(store)[0].originChannel).toBe("mail");
  });
});

describe("GET /api/attention", () => {
  it("serves the queue, token-gated", async () => {
    const prev = process.env.AIOS_UI_TOKEN;
    process.env.AIOS_UI_TOKEN = "att-token";
    const store = new Store(":memory:");
    // The endpoint uses the real clock, so the fixture must expire in the future, not on a fixed date.
    store.insertAction(action("a9", { expires_at: new Date(Date.now() + 86_400_000).toISOString() }));
    const deps = {
      store, goals: {}, vault: {}, registry: { agents: new Map(), departments: new Map(), agentOf: new Map() },
      reloadPacks: () => {}, envPath: "", uiDist: "", log: () => {},
      bus: {}, config: { dbPath: ":memory:" }, router: {}, gate: {},
      voice: { available: () => false }, mailbox: {},
    } as unknown as WebDeps;
    const server = startWebServer(deps, 0);
    if (!server.listening) await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/attention`)).status).toBe(401);
      const res = await fetch(`http://127.0.0.1:${port}/api/attention`, {
        headers: { Authorization: "Bearer att-token" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ kind: string; id: string; severity: number }>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ kind: "approval", id: "a9", severity: 1 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.AIOS_UI_TOKEN; else process.env.AIOS_UI_TOKEN = prev;
    }
  });
});
