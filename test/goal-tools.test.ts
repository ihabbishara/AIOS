// test/goal-tools.test.ts — /pause /resume /abandon router intercepts.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { MessageRouter } from "../src/router.js";
import type { GoalEngine } from "../src/engine/goals.js";

function fakeGoals() {
  const calls: string[] = [];
  return {
    calls,
    engine: {
      pauseGoal: (r: string) => { calls.push(`pause:${r}`); return `Goal ${r} paused.`; },
      resumeGoal: (r: string) => { calls.push(`resume:${r}`); return `Goal ${r} resumed.`; },
      abandonGoal: (r: string) => { calls.push(`abandon:${r}`); return `Goal ${r} abandoned; unfinished nodes skipped.`; },
    } as unknown as GoalEngine,
  };
}

function makeRouter(goals: GoalEngine) {
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  return new MessageRouter({
    moderator: {
      handle: async () => { throw new Error("moderator must not run"); },
      resetSession: () => {},
    },
    directChats: {
      handle: async () => { throw new Error("direct must not run"); },
      canonical: () => undefined,
      names: () => [],
    },
    chatBindings: new Map(),
    bus,
    goals,
  } as unknown as ConstructorParameters<typeof MessageRouter>[0]);
}

describe("router goal intercepts", () => {
  it("/pause /resume /abandon dispatch deterministically without an agent turn", async () => {
    const { calls, engine } = fakeGoals();
    const router = makeRouter(engine);
    const r1 = await router.handle({ channel: "telegram", chatId: "1", text: "/pause build-x", sender: {} });
    expect(r1?.text).toContain("paused");
    const r2 = await router.handle({ channel: "telegram", chatId: "1", text: "/resume build-x", sender: {} });
    expect(r2?.text).toContain("resumed");
    const r3 = await router.handle({ channel: "telegram", chatId: "1", text: "/abandon build-x", sender: {} });
    expect(r3?.text).toContain("abandoned");
    expect(calls).toEqual(["pause:build-x", "resume:build-x", "abandon:build-x"]);
  });

  it("/pause without a goal ref falls through (not intercepted)", async () => {
    const { engine } = fakeGoals();
    const router = makeRouter(engine);
    await expect(router.handle({ channel: "telegram", chatId: "1", text: "/pause", sender: {} }))
      .rejects.toThrow("moderator must not run");
  });
});
