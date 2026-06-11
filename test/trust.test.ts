// test/trust.test.ts
import { describe, it, expect } from "vitest";
import {
  newRecord, decide, recordApproval, recordRejection, promote, demote,
  type TrustPolicy,
} from "../src/kernel/trust.js";

const NOW = "2026-06-12T10:00:00.000Z";
const LATER = "2026-07-13T10:00:00.000Z"; // 31 days after NOW

const policy: TrustPolicy = {
  graduationStreak: 3,
  graduationAgeDays: 30,
  alwaysSupervised: new Set(["trust.promote", "purchase.buy"]),
};

describe("decide", () => {
  it("queues when no record exists (unknown type failsafe)", () => {
    expect(decide(undefined, policy)).toBe("queue");
  });

  it("queues supervised and graduating types", () => {
    const rec = newRecord("email.send", NOW);
    expect(decide(rec, policy)).toBe("queue");
    expect(decide({ ...rec, state: "graduating" }, policy)).toBe("queue");
  });

  it("executes autonomous types", () => {
    const rec = { ...newRecord("vault.write", NOW), state: "autonomous" as const };
    expect(decide(rec, policy)).toBe("execute");
  });

  it("hard ceiling: alwaysSupervised queues even when autonomous", () => {
    const rec = { ...newRecord("purchase.buy", NOW), state: "autonomous" as const };
    expect(decide(rec, policy)).toBe("queue");
  });
});

describe("recordApproval", () => {
  it("increments approvals and streak", () => {
    const { record } = recordApproval(newRecord("email.send", NOW), policy, NOW);
    expect(record.approvals).toBe(1);
    expect(record.streak).toBe(1);
    expect(record.state).toBe("supervised");
  });

  it("flags graduation when streak AND age thresholds met", () => {
    let rec = newRecord("email.send", NOW);
    let ready = false;
    for (let i = 0; i < 3; i++) ({ record: rec, graduationReady: ready } = recordApproval(rec, policy, LATER));
    expect(ready).toBe(true);
    expect(rec.state).toBe("graduating");
  });

  it("does NOT graduate before the age threshold", () => {
    let rec = newRecord("email.send", NOW);
    let ready = false;
    for (let i = 0; i < 5; i++) ({ record: rec, graduationReady: ready } = recordApproval(rec, policy, NOW));
    expect(ready).toBe(false);
    expect(rec.state).toBe("supervised");
  });

  it("never graduates alwaysSupervised types", () => {
    let rec = newRecord("purchase.buy", NOW);
    let ready = false;
    for (let i = 0; i < 10; i++) ({ record: rec, graduationReady: ready } = recordApproval(rec, policy, LATER));
    expect(ready).toBe(false);
    expect(rec.state).toBe("supervised");
  });

  it("only flags graduation once (graduating state does not re-flag)", () => {
    let rec = newRecord("email.send", NOW);
    for (let i = 0; i < 3; i++) ({ record: rec } = recordApproval(rec, policy, LATER));
    expect(rec.state).toBe("graduating");
    const { graduationReady } = recordApproval(rec, policy, LATER);
    expect(graduationReady).toBe(false);
  });
});

describe("recordRejection", () => {
  it("resets streak, demotes to supervised, stamps lastRejection", () => {
    const auto = { ...newRecord("email.send", NOW), state: "autonomous" as const, streak: 7, graduatedAt: NOW };
    const rec = recordRejection(auto, LATER);
    expect(rec.state).toBe("supervised");
    expect(rec.streak).toBe(0);
    expect(rec.rejections).toBe(1);
    expect(rec.lastRejection).toBe(LATER);
    expect(rec.graduatedAt).toBeNull();
  });
});

describe("promote / demote", () => {
  it("promote sets autonomous + graduatedAt", () => {
    const rec = promote(newRecord("email.send", NOW), LATER);
    expect(rec.state).toBe("autonomous");
    expect(rec.graduatedAt).toBe(LATER);
  });

  it("demote returns to supervised and clears graduatedAt", () => {
    const rec = demote(promote(newRecord("email.send", NOW), LATER));
    expect(rec.state).toBe("supervised");
    expect(rec.graduatedAt).toBeNull();
    expect(rec.streak).toBe(0);
  });
});
