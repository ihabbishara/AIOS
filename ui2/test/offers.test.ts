// ui2/test/offers.test.ts — the rest offers' one hard rule: they are the COMPLEMENT
// of the needs-you queue, never a second copy of it. Everything else here is about
// an idle agent only speaking when it has something real to point at.
import { describe, it, expect } from "vitest";
import { buildOffers, OFFERS_MAX } from "../src/lib/offers.js";
import type { AttentionItem, GoalView, OrgAgentCard, OrgDepartmentView } from "../src/api.js";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const TODAY = "2026-08-19";

const card = (
  name: string,
  status: OrgAgentCard["status"],
  extra: Partial<OrgAgentCard> = {},
): OrgAgentCard => ({
  name, title: "T", charter: "keep the lights on", visibility: "shared", guarded: false,
  status, currentTask: null, costTodayUsd: 0,
  lastActiveAt: null, costUsd: 0, nodes: 0, goalsLed: 0, mail: 0, runs: 0,
  ...extra,
});

const dept = (department: string, agents: OrgAgentCard[]): OrgDepartmentView => ({
  department, mission: "m", lead: agents[0]?.name ?? null,
  memoDomain: department, sandbox: false, actions: [], agents,
});

const goal = (id: string, lead: string, updatedAt: string, extra: Partial<GoalView> = {}): GoalView => ({
  id, slug: `slug-${id}`, title: `Goal ${id}`, department: "engineering", lead,
  originChannel: "web", status: "failed", planSummary: "", replansUsed: 0, error: "boom",
  createdAt: updatedAt, updatedAt, projectDir: null, goalDir: null, nodes: [],
  ...extra,
});

const goalRow = (goalId: string): AttentionItem => ({
  kind: "goal", id: goalId, title: "t", meta: "m", severity: 3,
  ts: "2026-08-19T00:00:00.000Z", actions: ["open"], ref: { goalId, slug: `slug-${goalId}` },
});

const build = (over: Partial<Parameters<typeof buildOffers>[0]> = {}) => buildOffers({
  org: [dept("engineering", [card("atlas", "idle")])],
  goals: [],
  unreadByAgent: {},
  attention: [],
  today: TODAY,
  now: NOW,
  ...over,
});

describe("buildOffers — revive", () => {
  it("offers a failed goal back to its idle lead, pointing at the goal", () => {
    const offers = build({ goals: [goal("g1", "atlas", "2026-08-14T12:00:00.000Z")] });
    expect(offers).toHaveLength(1);
    expect(offers[0].kind).toBe("revive");
    expect(offers[0].agent).toBe("atlas");
    expect(offers[0].text).toBe('I could pick "Goal g1" back up — it failed 5 days ago.');
    expect(offers[0].action).toEqual({ nav: "goals/slug-g1" });
  });

  it("stays quiet inside the 48h window — the Dock still owns a fresh failure", () => {
    // The attention view lists failed goals for 48h. Offering one back at 12h would
    // put the same goal on screen twice, once as a demand and once as a suggestion.
    expect(build({ goals: [goal("g1", "atlas", "2026-08-19T00:00:00.000Z")] })).toEqual([]);
  });

  it("excludes a goal the attention view is already carrying, however old", () => {
    const goals = [goal("g1", "atlas", "2026-08-14T12:00:00.000Z")];
    expect(build({ goals, attention: [goalRow("g1")] })).toEqual([]);
    // …and a parked review, whose row id is "<goalId>:<node>" — the match is on ref.
    const review: AttentionItem = {
      kind: "review", id: "g1:draft", title: "t", meta: "m", severity: 2,
      ts: "2026-08-19T00:00:00.000Z", actions: ["accept"], ref: { goalId: "g1", node: "draft" },
    };
    expect(build({ goals, attention: [review] })).toEqual([]);
  });

  it("says nothing when the lead is mid-turn — a busy agent is not offering anything", () => {
    expect(build({
      org: [dept("engineering", [card("atlas", "working", { currentTask: "node 3/5" })])],
      goals: [goal("g1", "atlas", "2026-08-14T12:00:00.000Z")],
    })).toEqual([]);
  });
});

describe("buildOffers — inbox", () => {
  it("carries the real unread count into both the sentence and the seed", () => {
    const offers = build({ unreadByAgent: { atlas: 3 } });
    expect(offers).toHaveLength(1);
    expect(offers[0].kind).toBe("inbox");
    expect(offers[0].text).toBe("3 unread memos in my inbox — want me to work through them?");
    expect(offers[0].action).toEqual({
      chat: { target: "atlas", seed: "You have 3 unread memos — please process them and report back." },
    });
  });

  it("reads as one memo, not 1 memos", () => {
    expect(build({ unreadByAgent: { atlas: 1 } })[0].text)
      .toBe("1 unread memo in my inbox — want me to work through it?");
  });

  it("ignores a zero count and an agent who is not idle", () => {
    expect(build({ unreadByAgent: { atlas: 0 } })).toEqual([]);
    expect(build({
      org: [dept("engineering", [card("atlas", "waiting")])],
      unreadByAgent: { atlas: 4 },
    })).toEqual([]);
  });
});

describe("buildOffers — hands", () => {
  it("offers exactly one pair of idle hands, the stalest", () => {
    const offers = build({
      org: [dept("engineering", [
        card("atlas", "idle", { lastActiveAt: "2026-08-01" }),
        card("vulcan", "idle", { lastActiveAt: "2026-07-20" }),
      ])],
    });
    expect(offers).toHaveLength(1);
    expect(offers[0].kind).toBe("hands");
    expect(offers[0].agent).toBe("vulcan");
    expect(offers[0].text).toBe("My hands are free — nothing has needed me in 30 days.");
  });

  it("derives the seed from the charter — an empty charter has nothing to offer", () => {
    const seeded = build({
      org: [dept("engineering", [card("atlas", "idle", { lastActiveAt: "2026-08-01", charter: "run the release train" })])],
    });
    expect(seeded[0].action).toEqual({
      chat: {
        target: "atlas",
        seed: "Nothing has needed you in 18 days. Your charter: run the release train — what is the most useful thing you could do about it today?",
      },
    });
    expect(build({
      org: [dept("engineering", [card("atlas", "idle", { lastActiveAt: "2026-08-01", charter: "  " })])],
    })).toEqual([]);
  });

  it("leaves a recently-active and a never-run agent alone", () => {
    expect(build({
      org: [dept("engineering", [
        card("atlas", "idle", { lastActiveAt: "2026-08-18" }),
        card("vulcan", "idle", { lastActiveAt: null }),
      ])],
    })).toEqual([]);
  });
});

describe("buildOffers — the strip as a whole", () => {
  const busyOrg = [dept("engineering", [
    card("atlas", "idle", { lastActiveAt: "2026-07-20" }),
    card("vulcan", "idle"),
    card("odin", "idle"),
  ])];
  const manyGoals = [
    goal("g1", "atlas", "2026-08-14T12:00:00.000Z"),
    goal("g2", "vulcan", "2026-08-16T12:00:00.000Z"),
    goal("g3", "odin", "2026-08-10T12:00:00.000Z"),
  ];

  it(`caps at ${OFFERS_MAX} — a longer list is a queue, and the Dock is the queue`, () => {
    const offers = build({ org: busyOrg, goals: manyGoals, unreadByAgent: { vulcan: 2, odin: 1 } });
    expect(offers).toHaveLength(OFFERS_MAX);
    expect(offers.every((o) => o.kind === "revive")).toBe(true);
  });

  it("orders revive over inbox over hands, newest first inside a kind", () => {
    const offers = build({
      org: busyOrg,
      goals: [manyGoals[0], manyGoals[1]],
      unreadByAgent: { vulcan: 2 },
    });
    expect(offers.map((o) => o.id)).toEqual(["revive:g2", "revive:g1", "inbox:vulcan"]);
  });

  it("is deterministic — a reshuffled org or goal list produces the same strip", () => {
    const args = { org: busyOrg, goals: [manyGoals[0], manyGoals[1]], unreadByAgent: { vulcan: 2, odin: 3 } };
    const shuffled = {
      org: [dept("engineering", [...busyOrg[0].agents].reverse())],
      goals: [manyGoals[1], manyGoals[0]],
      unreadByAgent: { odin: 3, vulcan: 2 },
    };
    expect(build(shuffled).map((o) => o.id)).toEqual(build(args).map((o) => o.id));
  });

  it("offers nothing while the reads are still in flight", () => {
    // 404 / in-flight leaves useLiveQuery data undefined. An agent claiming an empty
    // inbox it has not read yet would be a guess dressed as a statement.
    expect(build({ org: busyOrg, goals: undefined, unreadByAgent: undefined }))
      .toEqual([{
        id: "hands:atlas", agent: "atlas", kind: "hands",
        text: "My hands are free — nothing has needed me in 30 days.",
        action: {
          chat: {
            target: "atlas",
            seed: "Nothing has needed you in 30 days. Your charter: keep the lights on — what is the most useful thing you could do about it today?",
          },
        },
        ts: "2026-07-20",
      }]);
    // With nothing stale either, the strip is empty outright.
    expect(build({
      org: [dept("engineering", [card("atlas", "idle")])],
      goals: undefined,
      unreadByAgent: undefined,
    })).toEqual([]);
  });
});
