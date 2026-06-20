import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { indexDecision } from "../src/memory/indexer.js";
import { recall } from "../src/memory/recall.js";
import type { ActionRow } from "../src/kernel/actions.js";

function resolved(type: string, preview: string): ActionRow {
  const now = "2026-06-19T03:00:00.000Z";
  return {
    id: type.replace(/\W/g, "").slice(0, 8), type, payload: "{}", preview,
    status: "executed", origin_channel: "system", origin_chat_id: "speculate-email",
    trust_state: "supervised", verdict_by: "user", reject_reason: null, result: "ok",
    created_at: now, resolved_at: now, expires_at: now,
  };
}

describe("email recall exclusion — email.* decisions never reach recall (Vector A)", () => {
  it("email.draft preview (recipient/subject) is not indexed", () => {
    const s = new Store(":memory:");
    s.insertAction(resolved("email.draft", 'Draft to secret@example.com: "SecretSubject"'));
    indexDecision(s, "emaildra");
    expect(recall(s, "SecretSubject")).toEqual([]);
    expect(recall(s, "secret@example.com")).toEqual([]);
  });

  it("non-email decisions still index (skip is email-specific)", () => {
    const s = new Store(":memory:");
    s.insertAction(resolved("vault.write", "Wrote note UniqueMarkerFoo"));
    indexDecision(s, "vaultwri");
    expect(recall(s, "UniqueMarkerFoo").length).toBeGreaterThan(0);
  });
});
