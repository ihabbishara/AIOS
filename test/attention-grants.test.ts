// test/attention-grants.test.ts — a ⑯ park folds its proposed grant into the review row
// (triage-inbox spec §A): linking, suppression, expiry, guard-layer, multi-wall.
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import type { ActionRow } from "../src/kernel/actions.js";
import { appendEvents } from "../src/engine/journal.js";
import { buildAttentionView } from "../src/web/attention-view.js";

const NOW = () => new Date("2026-07-13T10:00:00.000Z");

const ALLOWLIST_LINE = (role: string, tool: string) =>
  `${role} was denied: ${tool} (not in allowlist). A permission grant is queued in Actions — approve it (or reject), then Retry.`;
const GUARD_LINE =
  'clio was denied: Bash — "workspace required". This is engine policy, not a grantable permission; fix the cause (e.g. reopen with guidance, or give the goal a workspace) and Retry.';

function grantAction(id: string, role: string, tool: string, over: Partial<ActionRow> = {}): ActionRow {
  return {
    id, type: "permission.grant", payload: JSON.stringify({ role, tool }),
    preview: `grant ${role} ${tool}`, status: "proposed",
    origin_channel: "engine", origin_chat_id: "goals", trust_state: "supervised",
    verdict_by: null, reject_reason: null, result: null,
    created_at: "2026-07-13T09:00:00.000Z", resolved_at: null,
    expires_at: "2026-07-14T09:00:00.000Z", ...over,
  };
}

function parkedStore(objections: string[]) {
  const store = new Store(":memory:");
  appendEvents(store, "g1", [
    { type: "goal.created", payload: {
      slug: "build-x", title: "Build X", request: "r", department: "engineering", lead: "athena",
      origin: { channel: "t", chatId: "1" }, chainDepth: 0, spawnedByMail: null,
      planSummary: "planned", goalDir: "d", projectDir: null } },
    { type: "plan.recorded", payload: { summary: "s", needsWorkspace: "none", nodes: [
      { key: "impl", kind: "loop", agent: "clio", critic: "minos", brief: "b", dependsOn: [], maxRounds: 2 },
    ] } },
    { type: "workspace.prepared", payload: { taskDir: null, mode: null } },
    { type: "review.requested", payload: { node: "impl", lastArtifactRef: "impl-a1-denied.md", objections } },
  ]);
  return store;
}

describe("attention — grant↔park fold", () => {
  it("links the proposed grant onto the review item and suppresses the standalone row", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash")]);
    store.insertAction(grantAction("act-1", "clio", "Bash"));
    const items = buildAttentionView(store, undefined, NOW);
    const review = items.find((i) => i.kind === "review")!;
    expect(review.grants).toEqual([{ id: "act-1", role: "clio", tool: "Bash" }]);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(0);
  });

  it("an expired grant is neither linked nor listed", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash")]);
    store.insertAction(grantAction("act-2", "clio", "Bash", { expires_at: "2026-07-13T09:59:00.000Z" }));
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.find((i) => i.kind === "review")!.grants).toBeUndefined();
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(0);
  });

  it("a guard-layer park links nothing; an unmatched grant stays a standalone row", () => {
    const store = parkedStore([GUARD_LINE]);
    store.insertAction(grantAction("act-3", "hera", "WebSearch"));
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.find((i) => i.kind === "review")!.grants).toBeUndefined();
    expect(items.filter((i) => i.kind === "approval").map((i) => i.id)).toEqual(["act-3"]);
  });

  it("a multi-wall park carries every matching grant on one row", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash"), ALLOWLIST_LINE("clio", "WebSearch")]);
    store.insertAction(grantAction("act-4", "clio", "Bash"));
    store.insertAction(grantAction("act-5", "clio", "WebSearch"));
    const items = buildAttentionView(store, undefined, NOW);
    const review = items.find((i) => i.kind === "review")!;
    expect(review.grants?.map((g) => g.id).sort()).toEqual(["act-4", "act-5"]);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(0);
  });

  it("a non-grant proposed action is never folded", () => {
    const store = parkedStore([ALLOWLIST_LINE("clio", "Bash")]);
    store.insertAction(grantAction("act-6", "clio", "Bash", { type: "test.echo", payload: "{}" }));
    const items = buildAttentionView(store, undefined, NOW);
    expect(items.find((i) => i.kind === "review")!.grants).toBeUndefined();
    expect(items.filter((i) => i.kind === "approval").map((i) => i.id)).toEqual(["act-6"]);
  });
});
