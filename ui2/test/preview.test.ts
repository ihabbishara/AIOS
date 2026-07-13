// ui2/test/preview.test.ts
import { describe, it, expect } from "vitest";
import { parseApproval } from "../src/lib/preview.js";
import type { ActionInfo } from "../src/api.js";

const action = (type: string, payload: unknown, preview = "p"): ActionInfo => ({
  id: "x", type, payload: JSON.stringify(payload), preview, status: "proposed",
  origin_channel: "cli", origin_chat_id: "l", trust_state: "supervised",
  verdict_by: null, reject_reason: null, result: null,
  created_at: "t", resolved_at: null, expires_at: "t",
});

describe("parseApproval", () => {
  it("email.draft → email form", () => {
    expect(parseApproval(action("email.draft", { to: "a@b.c", subject: "Hi", body: "text" })))
      .toEqual({ form: "email", to: "a@b.c", subject: "Hi", body: "text" });
  });
  it("vault.write → path + markdown", () => {
    expect(parseApproval(action("vault.write", { path: "notes/x.md", content: "# X" })))
      .toEqual({ form: "vault", path: "notes/x.md", markdown: "# X" });
  });
  it("permission.grant → role/tool delta", () => {
    expect(parseApproval(action("permission.grant", { role: "researcher", tool: "WebSearch" })))
      .toEqual({ form: "permission", role: "researcher", tool: "WebSearch", op: "grant" });
  });
  it("unknown type → generic fields; junk payload survives", () => {
    const g = parseApproval(action("bank.transfer", { amount: 5, note: "x" }, "Transfer €5"));
    expect(g.form).toBe("generic");
    if (g.form === "generic") {
      expect(g.preview).toBe("Transfer €5");
      expect(g.fields).toContainEqual(["amount", "5"]);
    }
    expect(parseApproval({ ...action("t", {}), payload: "not json" }).form).toBe("generic");
  });
});
