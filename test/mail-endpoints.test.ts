// test/mail-endpoints.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type MailKind, type MailStatus } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildMailView, buildGoalDetail, buildMailUnread, buildMailThread } from "../src/web/goals-view.js";
import { MAIL_PREFIX } from "../src/engine/goals.js";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "me-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "vulcan.yaml"),
    "name: vulcan\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\naliases: [developer]\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();

describe("buildMailView", () => {
  it("lists mail camelCased, alias-canonicalized filter", () => {
    const store = new Store(":memory:");
    store.insertMail({
      id: "m1", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "x", goal_id: null,
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "queued", error: null,
    });
    const all = buildMailView(store, registry);
    expect(all[0]).toMatchObject({ id: "m1", from: "athena", to: "vulcan", chainDepth: 1 });
    expect(buildMailView(store, registry, "developer").length).toBe(1); // alias → vulcan
    expect(buildMailView(store, registry, "athena").length).toBe(1);
    expect(buildMailView(store, registry, "nobody").length).toBe(0);
  });
});

describe("buildMailUnread", () => {
  it("totals + per-agent unread, status='unread' only", () => {
    const store = new Store(":memory:");
    const put = (id: string, to: string, status: MailStatus, kind: MailKind = "note") =>
      store.insertMail({
        id, from_agent: "athena", to_agent: to, kind, body: "x", goal_id: null,
        origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status, error: null,
      });
    put("u1", "vulcan", "unread");
    put("u2", "athena", "unread", "report");
    put("q1", "vulcan", "queued", "request"); // excluded — work, not inbox
    put("rd", "athena", "read");              // excluded — already seen
    expect(buildMailUnread(store)).toEqual({ total: 2, byAgent: { vulcan: 1, athena: 1 } });
  });

  it("empty store → zero total, empty map", () => {
    expect(buildMailUnread(new Store(":memory:"))).toEqual({ total: 0, byAgent: {} });
  });
});

describe("goal detail spawnedBy", () => {
  it("mail-spawned goal exposes provenance; normal goal null", () => {
    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "me-vault-")), "AIOS");
    store.insertMail({
      id: "m1", from_agent: "athena", to_agent: "vulcan", kind: "request", body: "x", goal_id: "g1",
      origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "spawned", error: null,
    });
    store.insertGoal({
      id: "g1", slug: "x", title: "X", request: "x", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: `${MAIL_PREFIX}m1`, replans_used: 0, error: null, chain_depth: 1,
      spawned_by_mail: "m1",
    });
    store.insertGoal({
      id: "g2", slug: "y", title: "Y", request: "y", department: "engineering", lead: "athena",
      origin_channel: "telegram", origin_chat_id: "1", status: "done", project_dir: null, goal_dir: null,
      plan_summary: "planned", replans_used: 0, error: null, chain_depth: 0,
    });
    expect(buildGoalDetail(store, vault, "g1")!.spawnedBy).toEqual({ mailId: "m1", from: "athena" });
    expect(buildGoalDetail(store, vault, "g2")!.spawnedBy).toBeNull();
  });

  it("buildMailThread returns the conversation oldest-first", () => {
    const store = new Store(":memory:");
    store.insertMail({ id: "root", from_agent: "athena", to_agent: "vulcan", kind: "request",
      body: "which db?", goal_id: null, origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "spawned", error: null, thread_id: "root", in_reply_to: null });
    store.insertMail({ id: "rep", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "Done: sqlite", goal_id: "g", origin_channel: "telegram", origin_chat_id: "1",
      chain_depth: 1, status: "unread", error: null, thread_id: "root", in_reply_to: "root" });
    expect(buildMailThread(store, "root").map((m) => m.id)).toEqual(["root", "rep"]);
    expect(buildMailThread(store, "nope")).toEqual([]);
  });
});
