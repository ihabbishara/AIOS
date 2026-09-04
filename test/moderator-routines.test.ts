// test/moderator-routines.test.ts — routine CRUD tools (spec 2026-07-25).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { buildModeratorServer, type ModeratorToolsDeps } from "../src/moderator/tools.js";
import type { VaultWriter } from "../src/vault/writer.js";
import type { ActionGate } from "../src/kernel/gate.js";
import type { GoogleAccounts } from "../src/senses/google/auth.js";
import type { GoalEngine } from "../src/engine/goals.js";

type ToolHandler = (a: unknown) => Promise<{ content: Array<{ text: string }> }>;
function handlers(server: unknown) {
  return (server as unknown as {
    instance: { _registeredTools: Record<string, { handler: ToolHandler }> };
  }).instance._registeredTools;
}
const callText = async (h: { handler: ToolHandler }, a: unknown) => (await h.handler(a)).content[0].text;

function build(store: Store) {
  const deps: ModeratorToolsDeps = {
    goals: null as unknown as GoalEngine,
    departments: [], coordinator: "neo",
    store,
    vault: null as unknown as VaultWriter,
    projectsRoot: "/tmp",
    origin: { channel: "telegram", chatId: "42" },
    handOff: async () => ({ text: "" }),
    agentNames: ["maya"],
    gate: null as unknown as ActionGate,
    actionTypes: [],
    google: null as unknown as GoogleAccounts,
    memory: { halfLifeDays: 90, stalePenalty: 0.7 },
  };
  return handlers(buildModeratorServer(deps));
}

describe("routine tools", () => {
  it("add_routine stores a daily routine with the current chat as origin", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    const out = await callText(t["add_routine"], {
      name: "morning news", prompt: "research and send the news", kind: "daily", hhmm: "07:00",
    });
    expect(out).toContain("07:00");
    const rows = store.listRoutines();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "morning news", prompt: "research and send the news",
      recurrence: JSON.stringify({ kind: "daily", hhmm: "07:00" }),
      origin_channel: "telegram", origin_chat_id: "42",
    });
  });

  it("add_routine refuses an invalid recurrence and writes nothing", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    const out = await callText(t["add_routine"], { name: "x", prompt: "y", kind: "weekly", hhmm: "09:00" }); // dow missing
    expect(out).toContain("Refused");
    expect(store.listRoutines()).toHaveLength(0);
  });

  it("list_routines renders id, state and schedule", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    await callText(t["add_routine"], { name: "standup", prompt: "post standup", kind: "weekdays", hhmm: "09:30" });
    const out = await callText(t["list_routines"], {});
    expect(out).toContain("#1");
    expect(out).toContain("standup");
    expect(out).toContain("09:30");
  });

  it("update_routine disables a routine", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    await callText(t["add_routine"], { name: "n", prompt: "p", kind: "interval", every_minutes: 90 });
    const out = await callText(t["update_routine"], { id: 1, enabled: false });
    expect(out).toContain("#1");
    expect(store.listRoutines()[0].enabled).toBe(0);
  });

  it("delete_routine removes it; a missing id is reported", async () => {
    const store = new Store(":memory:");
    const t = build(store);
    await callText(t["add_routine"], { name: "n", prompt: "p", kind: "daily", hhmm: "08:00" });
    expect(await callText(t["delete_routine"], { id: 1 })).toContain("deleted");
    expect(store.listRoutines()).toHaveLength(0);
    expect(await callText(t["delete_routine"], { id: 99 })).toContain("No routine");
  });
});
