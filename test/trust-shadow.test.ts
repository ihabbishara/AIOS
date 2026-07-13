// test/trust-shadow.test.ts — shadow-match counter semantics (verification-hardening §6).
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import {
  newRecord, recordRejection, recordShadowMatch, promote, demote,
  type TrustPolicy, type TrustRecord,
} from "../src/kernel/trust.js";

const NOW = "2026-07-14T10:00:00.000Z";
const POLICY: TrustPolicy = {
  graduationStreak: 3, graduationAgeDays: 0, shadowMatches: 3, alwaysSupervised: new Set(["trust.promote"]),
};

describe("recordShadowMatch", () => {
  it("counts consecutive matches while graduating and flags promotion at the threshold", () => {
    let rec: TrustRecord = { ...newRecord("fake.op", NOW), state: "graduating" };
    let ready = false;
    for (let i = 1; i <= 3; i++) {
      ({ record: rec, promotionReady: ready } = recordShadowMatch(rec, POLICY));
      expect(rec.shadowMatches).toBe(i);
      expect(ready).toBe(i >= 3);
    }
  });

  it("is a no-op for non-graduating states", () => {
    const rec = newRecord("fake.op", NOW); // supervised
    expect(recordShadowMatch(rec, POLICY)).toEqual({ record: rec, promotionReady: false });
  });

  it("rejection resets the match counter AND demotes (mismatch semantics)", () => {
    const rec = { ...newRecord("fake.op", NOW), state: "graduating" as const, shadowMatches: 2 };
    const after = recordRejection(rec, NOW);
    expect(after.state).toBe("supervised");
    expect(after.shadowMatches).toBe(0);
  });

  it("promote and demote both reset the counter", () => {
    const rec = { ...newRecord("fake.op", NOW), state: "graduating" as const, shadowMatches: 5 };
    expect(promote(rec, NOW).shadowMatches).toBe(0);
    expect(demote(rec).shadowMatches).toBe(0);
  });
});

describe("store — shadow columns", () => {
  it("round-trips shadowMatches through upsertTrust/getTrust", () => {
    const store = new Store(":memory:");
    store.upsertTrust({ ...newRecord("fake.op", NOW), shadowMatches: 7 });
    expect(store.getTrust("fake.op")!.shadowMatches).toBe(7);
  });

  it("shadowStats aggregates matches (approved) vs mismatches (rejected) per type", () => {
    const store = new Store(":memory:");
    const base = {
      type: "fake.op", payload: "{}", preview: "p", origin_channel: "cli", origin_chat_id: "l",
      trust_state: "graduating", verdict_by: null as string | null, reject_reason: null, result: null,
      created_at: NOW, resolved_at: null as string | null, expires_at: "2099-01-01T00:00:00.000Z",
      shadow_decision: "execute" as string | null,
    };
    store.insertAction({ ...base, id: "a1", status: "executed", verdict_by: "ihab", resolved_at: NOW });
    store.insertAction({ ...base, id: "a2", status: "rejected", verdict_by: "ihab", resolved_at: NOW });
    store.insertAction({ ...base, id: "a3", status: "proposed" }); // pending — counts as neither
    store.insertAction({ ...base, id: "a4", status: "executed", verdict_by: "ihab", resolved_at: NOW, shadow_decision: null }); // not shadowed
    expect(store.shadowStats()).toEqual([{ type: "fake.op", matches: 1, mismatches: 1 }]);
  });
});
