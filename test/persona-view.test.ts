// test/persona-view.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { buildAgentActivity } from "../src/web/persona-view.js";
import { fixtureRegistry } from "./org-view.test.js";

function harness() {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  return { store, bus, registry: fixtureRegistry() };
}

describe("buildAgentActivity", () => {
  it("returns null for unknown agents", () => {
    const { store, bus, registry } = harness();
    expect(buildAgentActivity("nobody", registry, store, bus)).toBeNull();
  });

  it("merges runs, routes, mail, and goal nodes newest-first; aliases canonicalize", () => {
    const { store, bus, registry } = harness();
    bus.emit({ type: "agent.end", agent: "developer", context: "chat:telegram:42", ok: true, costUsd: 0.1 });
    bus.emit({ type: "route.decision", to: "vulcan", via: "handoff", reason: "code change", channel: "telegram", chatId: "42" });
    bus.emit({ type: "mail.sent", id: "m1", from: "vulcan", to: "midas", kind: "request" });
    bus.emit({ type: "node.status", goalId: "g1", nodeKey: "implement", status: "done", agent: "vulcan" });
    bus.emit({ type: "agent.end", agent: "midas", context: "chat:telegram:9", ok: true }); // not vulcan's
    const a = buildAgentActivity("developer", registry, store, bus)!;
    expect(a.timeline.map((t) => t.kind)).toEqual(["goal", "mail", "route", "run"]); // newest first
    expect(a.timeline[3]).toMatchObject({ kind: "run", summary: "chat:telegram:42", ok: true });
    expect(a.timeline[2].summary).toBe("handoff: code change");
    expect(a.timeline.some((t) => t.summary.includes("telegram:9"))).toBe(false);
  });

  it("caps the timeline at 100 entries", () => {
    const { store, bus, registry } = harness();
    for (let i = 0; i < 120; i++) {
      bus.emit({ type: "agent.end", agent: "vulcan", context: `chat:t:${i}`, ok: true });
    }
    const a = buildAgentActivity("vulcan", registry, store, bus)!;
    expect(a.timeline).toHaveLength(100);
    expect(a.timeline[0].summary).toBe("chat:t:119"); // newest kept
  });

  it("lists goals with nodes filtered to the agent, skips uninvolved goals", () => {
    const { store, bus, registry } = harness();
    const goal = (id: string, title: string) => ({
      id, slug: id, title, request: "r", department: "engineering", lead: "vulcan",
      origin_channel: "telegram", origin_chat_id: "42", status: "running" as const,
      project_dir: null, goal_dir: null, plan_summary: "", replans_used: 0, chain_depth: 0, error: null,
    });
    store.insertGoal(goal("g1", "Fix auth"));
    store.insertGoal(goal("g2", "Taxes"));
    store.insertNodes("g1", [
      { node_key: "implement", type: "run", agent: "vulcan", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
      { node_key: "review", type: "verify", agent: "midas", critic: null, brief: "b", depends_on: ["implement"], max_rounds: 1 },
    ]);
    store.insertNodes("g2", [
      { node_key: "collect", type: "run", agent: "midas", critic: null, brief: "b", depends_on: [], max_rounds: 1 },
    ]);
    const a = buildAgentActivity("vulcan", registry, store, bus)!;
    expect(a.goals).toHaveLength(1);
    expect(a.goals[0]).toMatchObject({ goalId: "g1", title: "Fix auth", status: "running" });
    expect(a.goals[0].nodes).toEqual([{ key: "implement", status: "pending" }]);
  });

  it("returns agent mail with a body snippet", () => {
    const { store, bus, registry } = harness();
    store.insertMail({
      id: "m1", from_agent: "vulcan", to_agent: "midas", kind: "request",
      body: "x".repeat(200), goal_id: null, origin_channel: "telegram",
      origin_chat_id: "42", chain_depth: 0, status: "unread", error: null,
    });
    const a = buildAgentActivity("vulcan", registry, store, bus)!;
    expect(a.mail).toHaveLength(1);
    expect(a.mail[0]).toMatchObject({ id: "m1", from: "vulcan", to: "midas", kind: "request", status: "unread" });
    expect(a.mail[0].snippet).toHaveLength(120);
  });
});
