// test/mailbox.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox } from "../src/mail/mailbox.js";
import type { AiosEvent } from "../src/events.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "mb-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "aliases: [developer]\n"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"),
    "name: midas\ntitle: CFO\ndepartment: finance\ncharter: c.\npersona: p.\nprompt: x.\ntools: []\nvisibility: private\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const PRIMARY = { channel: "telegram", chatId: "1" };
const CTX = { from: "athena", origin: PRIMARY, goalDepth: 0 };

function harness(over: Partial<ConstructorParameters<typeof Mailbox>[0]> = {}) {
  const store = new Store(":memory:");
  const events: AiosEvent[] = [];
  let queued = 0;
  const mb = new Mailbox({
    store, registry, maxDepth: 2, disabled: false, primaryChat: PRIMARY,
    onEvent: (e) => events.push(e), onQueued: () => queued++, ...over,
  });
  return { store, mb, events, queuedCount: () => queued };
}

describe("Mailbox.send", () => {
  it("queues a request (alias canonicalized), emits mail.sent, fires onQueued", () => {
    const { store, mb, events, queuedCount } = harness();
    const out = mb.send(CTX, { to: "developer", kind: "request", body: "build X" });
    expect(out).toContain("vulcan");
    const m = store.queuedRequests()[0];
    expect(m).toMatchObject({ from_agent: "athena", to_agent: "vulcan", chain_depth: 1, status: "queued" });
    expect(events[0]).toMatchObject({ type: "mail.sent", from: "athena", to: "vulcan", kind: "request" });
    expect(queuedCount()).toBe(1);
  });

  it("notes land unread and do not fire onQueued", () => {
    const { store, mb, queuedCount } = harness();
    mb.send(CTX, { to: "vulcan", kind: "note", body: "fyi" });
    expect(store.unreadMailFor("vulcan").length).toBe(1);
    expect(queuedCount()).toBe(0);
  });

  it("refuses: unknown recipient, self-send, disabled", () => {
    const { mb, store } = harness();
    expect(mb.send(CTX, { to: "nobody", kind: "note", body: "x" })).toContain("Unknown");
    expect(mb.send(CTX, { to: "athena", kind: "note", body: "x" })).toContain("yourself");
    const off = harness({ disabled: true });
    expect(off.mb.send(CTX, { to: "vulcan", kind: "note", body: "x" })).toContain("disabled");
    expect(store.listMail().length).toBe(0);
  });

  it("private recipient walled: refused from shared origin, fail-closed without primaryChat, allowed from primary", () => {
    const { mb } = harness();
    const shared = { ...CTX, origin: { channel: "telegram", chatId: "999" } };
    expect(mb.send(shared, { to: "midas", kind: "request", body: "x" })).toContain("private");
    const noPrimary = harness({ primaryChat: undefined });
    expect(noPrimary.mb.send(CTX, { to: "midas", kind: "request", body: "x" })).toContain("private");
    const ok = harness();
    expect(ok.mb.send(CTX, { to: "midas", kind: "request", body: "x" })).toContain("midas");
  });

  it("chain_depth = goalDepth + 1", () => {
    const { store, mb } = harness();
    mb.send({ ...CTX, goalDepth: 2 }, { to: "vulcan", kind: "request", body: "x" });
    expect(store.queuedRequests()[0].chain_depth).toBe(3);
  });
});

describe("Mailbox.injectionFor", () => {
  it("renders unread inbound + own refusals, truncates, caps at 5, marks read", () => {
    const { store, mb } = harness();
    for (let i = 0; i < 5; i++) {
      store.insertMail({
        id: `n${i}`, from_agent: "athena", to_agent: "vulcan", kind: "note", body: "y".repeat(600),
        goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
      });
    }
    store.insertMail({
      id: "r1", from_agent: "vulcan", to_agent: "midas", kind: "request", body: "z",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "999", chain_depth: 1, status: "refused", error: "private wall",
    });
    const block = mb.injectionFor("vulcan");
    expect(block).toContain("# Mail");
    expect(block).toContain("from athena");
    expect(block).not.toContain("y".repeat(501));   // truncated at 500
    expect(block).not.toContain("refused");          // cap 5 hit by the unread notes first
    expect(store.unreadMailFor("vulcan")).toEqual([]);
    // second call now surfaces the refusal ack
    const block2 = mb.injectionFor("vulcan");
    expect(block2).toContain("your request to midas was refused: private wall");
    expect(mb.injectionFor("vulcan")).toBe("");      // everything acked
  });
});
