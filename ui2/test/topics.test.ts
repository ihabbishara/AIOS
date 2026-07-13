// ui2/test/topics.test.ts
import { describe, it, expect } from "vitest";
import { T, matches, lastMatching } from "../src/lib/topics.js";
import type { StoredEvent } from "../src/api.js";

const ev = (id: number, type: string): StoredEvent => ({ id, ts: "t", event: { type } });

describe("topics", () => {
  it("prefix vs exact matching", () => {
    expect(matches("action.proposed", T.attention)).toBe(true);
    expect(matches("goal.status", T.attention)).toBe(true);
    expect(matches("goal.created", T.attention)).toBe(false); // exact, not prefix
    expect(matches("mail.received", T.attention)).toBe(false); // Gmail sense stays out
  });
  it("lastMatching returns newest matching id", () => {
    const events = [ev(1, "action.proposed"), ev(2, "chat.out"), ev(3, "mail.read")];
    expect(lastMatching(events, T.attention)).toBe(3);
    expect(lastMatching(events, ["chat."])).toBe(2);
    expect(lastMatching(events, ["nope"])).toBeUndefined();
  });
});
