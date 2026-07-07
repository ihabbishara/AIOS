// test/mail-recall-indexing.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type MailRow } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { recall } from "../src/memory/recall.js";
import { indexMailThread, reconcile } from "../src/memory/indexer.js";

/** engineering (code): athena, vulcan — shared. finance (money): midas private, ledger shared. */
function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "mri-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  const fin = join(agentsDir, "finance");
  mkdirSync(eng, { recursive: true });
  mkdirSync(fin, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  const agent = (name: string, dept: string, extra = "") =>
    `name: ${name}\ntitle: T\ndepartment: ${dept}\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n${extra}`;
  writeFileSync(join(eng, "athena.yaml"), agent("athena", "engineering"));
  writeFileSync(join(eng, "vulcan.yaml"), agent("vulcan", "engineering"));
  writeFileSync(join(fin, "department.yaml"),
    "department: finance\nmission: Money.\nlead: midas\nmemoDomain: money\nplaybooks: []\nprivateMemo: true\n");
  writeFileSync(join(fin, "midas.yaml"), agent("midas", "finance", "visibility: private\n"));
  writeFileSync(join(fin, "ledger.yaml"), agent("ledger", "finance"));
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();

function mailRow(over: Partial<MailRow> = {}): Omit<MailRow, "created_at" | "read_at"> {
  return {
    id: over.id ?? "m1", from_agent: over.from_agent ?? "athena", to_agent: over.to_agent ?? "vulcan",
    kind: over.kind ?? "request", body: over.body ?? "body", goal_id: null,
    origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1,
    status: over.status ?? "queued", error: null,
    thread_id: over.thread_id, in_reply_to: over.in_reply_to ?? null,
  };
}

describe("listMailThreadIds", () => {
  it("returns distinct thread ids", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "a", thread_id: "t1" }));
    store.insertMail(mailRow({ id: "b", thread_id: "t1" }));
    store.insertMail(mailRow({ id: "c" })); // thread_id defaults to own id
    expect(store.listMailThreadIds().sort()).toEqual(["c", "t1"]);
  });
});

describe("indexMailThread", () => {
  it("indexes an agent↔agent thread under the root recipient's dept domain", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "please review the WAL checkpoint tuning", thread_id: "t1" }));
    store.insertMail(mailRow({
      id: "r1", from_agent: "vulcan", to_agent: "athena", kind: "report",
      body: "checkpoint interval doubled", thread_id: "t1", in_reply_to: "q1",
    }));
    indexMailThread(store, registry, "t1");
    const hits = recall(store, "checkpoint tuning", { domain: "code" });
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe("mail");
    expect(hits[0].ref).toBe("thread:t1");
    expect(hits[0].snippet).toContain("checkpoint");
    // both sides of the conversation are in the one doc
    expect(recall(store, "interval doubled", { domain: "code" })[0].ref).toBe("thread:t1");
  });

  it("never indexes a thread with a private participant", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "f1", to_agent: "midas", body: "our runway is eleven months", thread_id: "tf" }));
    indexMailThread(store, registry, "tf");
    expect(recall(store, "runway").length).toBe(0);
    expect(recall(store, "runway", { domain: "money" }).length).toBe(0);
    expect(store.memoryFingerprint("mail", "thread:tf")).toBeUndefined();
  });

  it("deletes a previously indexed thread when a participant turns private", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "rotate the api keys quarterly", thread_id: "t1" }));
    indexMailThread(store, registry, "t1");
    expect(recall(store, "rotate keys").length).toBe(1);
    const def = registry.agents.get("vulcan")!;
    def.manifest.visibility = "private";
    try {
      indexMailThread(store, registry, "t1");
      expect(recall(store, "rotate keys").length).toBe(0);
      expect(store.memoryFingerprint("mail", "thread:t1")).toBeUndefined();
    } finally {
      def.manifest.visibility = "shared";
    }
  });

  it("maps domains: shared finance recipient → money, user-ask → asker's dept, unknown → general", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "a", to_agent: "ledger", body: "quarterly invoice totals", thread_id: "ta" }));
    store.insertMail(mailRow({ id: "b", to_agent: "user", body: "should I archive the legacy repo", thread_id: "tb", status: "awaiting-human" }));
    store.insertMail(mailRow({ id: "c", to_agent: "ghost-agent", body: "orphaned correspondence", thread_id: "tc" }));
    indexMailThread(store, registry, "ta");
    indexMailThread(store, registry, "tb");
    indexMailThread(store, registry, "tc");
    expect(recall(store, "invoice totals", { domain: "money" })[0]?.ref).toBe("thread:ta");
    expect(recall(store, "archive legacy repo", { domain: "code" })[0]?.ref).toBe("thread:tb");
    expect(recall(store, "orphaned correspondence", { domain: "general" })[0]?.ref).toBe("thread:tc");
  });

  it("drops refused messages on rebuild (sweep refusal flips status after insert)", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "first question about caching", thread_id: "t1" }));
    store.insertMail(mailRow({
      id: "q2", from_agent: "vulcan", to_agent: "athena",
      body: "followup about eviction policy", thread_id: "t1",
    }));
    indexMailThread(store, registry, "t1");
    expect(recall(store, "eviction policy").length).toBe(1);
    store.refuseMail("q2", "chain too deep");
    indexMailThread(store, registry, "t1");
    expect(recall(store, "eviction policy").length).toBe(0);
    expect(recall(store, "caching").length).toBe(1); // non-refused survives
  });

  it("deletes the doc when every message in the thread is refused", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "misaddressed request", thread_id: "t1" }));
    indexMailThread(store, registry, "t1");
    expect(store.memoryFingerprint("mail", "thread:t1")).toBe("1:q1");
    store.refuseMail("q1", "unknown recipient");
    indexMailThread(store, registry, "t1");
    expect(store.memoryFingerprint("mail", "thread:t1")).toBeUndefined();
  });

  it("re-indexing an unchanged thread is a no-op (fingerprint short-circuit)", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({ id: "q1", body: "idempotence check", thread_id: "t1" }));
    indexMailThread(store, registry, "t1");
    const spy = vi.spyOn(store, "upsertMemoryDoc");
    indexMailThread(store, registry, "t1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("user-ask thread: question and human answer both recallable", () => {
    const store = new Store(":memory:");
    store.insertMail(mailRow({
      id: "ask1", to_agent: "user", body: "which cloud region should staging use",
      thread_id: "t1", status: "awaiting-human",
    }));
    store.insertMail(mailRow({
      id: "ans1", from_agent: "user", to_agent: "athena", kind: "report",
      body: "use the frankfurt region for staging", thread_id: "t1", in_reply_to: "ask1",
    }));
    indexMailThread(store, registry, "t1");
    expect(recall(store, "cloud region staging", { domain: "code" }).length).toBe(1);
    expect(recall(store, "frankfurt", { domain: "code" })[0].snippet).toContain("frankfurt");
  });
});

describe("reconcile mail pass", () => {
  it("backfills existing threads and deletes newly-walled docs", () => {
    const root = mkdtempSync(join(tmpdir(), "mri-vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.insertMail(mailRow({ id: "q1", body: "backfilled correspondence", thread_id: "t1" }));
    reconcile(store, vault, registry);
    expect(recall(store, "backfilled correspondence")[0].ref).toBe("thread:t1");
    const def = registry.agents.get("vulcan")!;
    def.manifest.visibility = "private";
    try {
      reconcile(store, vault, registry);
      expect(recall(store, "backfilled correspondence").length).toBe(0);
    } finally {
      def.manifest.visibility = "shared";
    }
  });

  it("skips the mail pass when no registry is given (legacy signature)", () => {
    const root = mkdtempSync(join(tmpdir(), "mri-vault-"));
    const store = new Store(":memory:");
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    store.insertMail(mailRow({ id: "q1", body: "invisible without registry", thread_id: "t1" }));
    reconcile(store, vault);
    expect(recall(store, "invisible without registry").length).toBe(0);
  });
});
