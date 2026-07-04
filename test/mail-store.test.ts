// test/mail-store.test.ts
import { describe, it, expect } from "vitest";
import { Store, type MailRow } from "../src/store/db.js";
import { defaultVerdict, Triage } from "../src/heartbeat/triage.js";
import { EventBus } from "../src/events.js";

function mail(over: Partial<MailRow> = {}): Omit<MailRow, "created_at" | "read_at"> {
  return {
    id: over.id ?? "m1", from_agent: "athena", to_agent: "vulcan", kind: "request",
    body: "build the thing", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
    chain_depth: 1, status: "queued", error: null, ...over,
  } as Omit<MailRow, "created_at" | "read_at">;
}

describe("mail store", () => {
  it("round-trips mail and lists by agent from either side", () => {
    const s = new Store(":memory:");
    s.insertMail(mail());
    s.insertMail(mail({ id: "m2", from_agent: "vulcan", to_agent: "athena", kind: "note", status: "unread" }));
    expect(s.getMail("m1")!.body).toBe("build the thing");
    expect(s.listMail("athena").map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect(s.listMail("vulcan").length).toBe(2);
    expect(s.listMail(undefined, 1).length).toBe(1);
  });

  it("request lifecycle: queued → spawned; refused; downgrade to note", () => {
    const s = new Store(":memory:");
    s.insertMail(mail());
    s.insertMail(mail({ id: "m2" }));
    s.insertMail(mail({ id: "m3" }));
    expect(s.queuedRequests().map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    s.markMailSpawned("m1", "g1");
    expect(s.getMail("m1")).toMatchObject({ status: "spawned", goal_id: "g1" });
    s.refuseMail("m2", "private wall");
    expect(s.getMail("m2")).toMatchObject({ status: "refused", error: "private wall" });
    s.downgradeMailToNote("m3", "downgraded: chain too deep");
    expect(s.getMail("m3")).toMatchObject({ kind: "note", status: "unread", error: "downgraded: chain too deep" });
    expect(s.queuedRequests()).toEqual([]);
  });

  it("unread/refused feeds + markMailRead", () => {
    const s = new Store(":memory:");
    s.insertMail(mail({ id: "n1", kind: "note", status: "unread", to_agent: "vulcan" }));
    s.insertMail(mail({ id: "r1", status: "refused", from_agent: "vulcan", to_agent: "midas", error: "wall" }));
    expect(s.unreadMailFor("vulcan").map((m) => m.id)).toEqual(["n1"]);
    expect(s.refusedMailFrom("vulcan").map((m) => m.id)).toEqual(["r1"]);
    s.markMailRead(["n1", "r1"]);
    expect(s.unreadMailFor("vulcan")).toEqual([]);
    expect(s.refusedMailFrom("vulcan")).toEqual([]); // read_at stamped = acknowledged
    expect(s.getMail("n1")!.status).toBe("read");
    expect(s.getMail("r1")!.status).toBe("refused"); // status preserved, only acked
  });

  it("goals carry chain_depth (default 0)", () => {
    const s = new Store(":memory:");
    s.insertGoal({
      id: "g1", slug: "x", title: "X", request: "x", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "running", project_dir: null,
      goal_dir: null, plan_summary: "", replans_used: 0, error: null, chain_depth: 2,
    });
    expect(s.getGoal("g1")!.chain_depth).toBe(2);
  });

  it("transaction rolls back on throw", () => {
    const s = new Store(":memory:");
    expect(() =>
      s.transaction(() => {
        s.insertMail(mail());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getMail("m1")).toBeUndefined();
  });
});

describe("mail triage defaults", () => {
  it("mail.sent and mail.spawned are ignore", () => {
    expect(defaultVerdict({ type: "mail.sent", id: "m", from: "a", to: "b", kind: "note" })).toBe("ignore");
    expect(defaultVerdict({ type: "mail.spawned", mailId: "m", goalId: "g" })).toBe("ignore");
  });

  it("a user mail.* rule cannot force a notify (hard guard, spec §7)", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.addTriageRule({ eventType: "mail.*", verdict: "notify_now", source: "manual" });
    const notified: string[] = [];
    const triage = new Triage({
      store, bus,
      classify: async () => { throw new Error("model must not be called"); },
      notify: async (e) => { notified.push(e.type); },
    });
    await triage.handle({ type: "mail.sent", id: "m", from: "a", to: "b", kind: "report" });
    await triage.handle({ type: "mail.spawned", mailId: "m", goalId: "g" });
    expect(notified).toEqual([]); // hard guard returns before the rule is consulted
  });
});
