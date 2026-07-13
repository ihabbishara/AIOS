// ui2/src/lib/preview.ts — typed approval previews for the canvas (spec §5: gate-authored preview by type).
import type { ActionInfo } from "../api.js";

export type ApprovalPreview =
  | { form: "email"; to: string; subject: string; body: string }
  | { form: "vault"; path: string; markdown: string }
  | { form: "permission"; role: string; tool: string; op: "grant" | "revoke" }
  | { form: "generic"; preview: string; fields: Array<[string, string]> };

export function parseApproval(a: ActionInfo): ApprovalPreview {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(a.payload) as Record<string, unknown>; } catch { /* keep {} */ }
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  if (a.type === "email.draft" || a.type === "email.send") {
    return { form: "email", to: s("to"), subject: s("subject"), body: s("body") };
  }
  if (a.type === "vault.write") {
    return { form: "vault", path: s("path") || s("file"), markdown: s("content") || s("body") };
  }
  if (a.type === "permission.grant" || a.type === "permission.revoke") {
    return { form: "permission", role: s("role"), tool: s("tool"), op: a.type.endsWith("grant") ? "grant" : "revoke" };
  }
  return {
    form: "generic", preview: a.preview,
    fields: Object.entries(p).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)] as [string, string]),
  };
}
