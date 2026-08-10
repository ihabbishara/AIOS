// test/wiki-maintenance.test.ts — the nightly wiki pass.
//
// The watermark tests are the ones that protect data: if it advances on a failed or
// budget-skipped night, that night's record is never ingested and nobody finds out.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { runWikiMaintenance, pickMaintainer, RECORD_DIRS } from "../src/heartbeat/wiki.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

/** Registry whose research lead really does hold vault_write + recall — the shared
 *  org-view fixture grants neither, so pickMaintainer would (correctly) find nobody. */
function wikiRegistry() {
  const root = mkdtempSync(join(tmpdir(), "wikireg-"));
  const agentsDir = join(root, "agents");
  const res = join(agentsDir, "research");
  const eng = join(agentsDir, "engineering");
  mkdirSync(res, { recursive: true });
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(agentsDir, "_capabilities.yaml"),
    "wiki-rw: { server: aios-pack, tools: [vault_write, recall] }\nplain: { tools: [Read] }\n");
  writeFileSync(join(res, "department.yaml"),
    "department: research\nmission: Know things.\nlead: lina\nmemoDomain: research\nsandbox: false\ncapabilities: [wiki-rw]\nplaybooks: []\n");
  writeFileSync(join(res, "lina.yaml"),
    "name: lina\ntitle: Librarian\ndepartment: research\ncharter: Curates.\npersona: Terse.\nprompt: You are lina.\nmaxTurns: 20\naliases: [analyst]\n");
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nmemoDomain: code\nsandbox: true\ncapabilities: [plain]\nplaybooks: []\n");
  writeFileSync(join(eng, "maya.yaml"),
    "name: maya\ntitle: Engineer\ndepartment: engineering\ncharter: Builds.\npersona: Terse.\nprompt: You are maya.\nmaxTurns: 20\nkind: coordinator\naliases: [developer]\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

function harness(opts: { allow?: boolean } = {}) {
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "wiki-")), "AIOS");
  vault.init("2026-08-10");
  const registry = wikiRegistry();
  const run = vi.fn().mockResolvedValue({ text: "done", costUsd: 0.1 });
  const spendGuard = { allow: () => opts.allow ?? true } as never;
  return { store, vault, registry, run, spendGuard };
}

/** Writes a record file with an mtime the test controls. */
function record(vault: VaultWriter, rel: string, mtimeIso: string): void {
  const path = join(vault.root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "# note\n\nbody\n");
  const t = new Date(mtimeIso);
  utimesSync(path, t, t);
}

describe("runWikiMaintenance", () => {
  it("hands the maintainer only what changed since the last pass", async () => {
    const h = harness();
    h.store.kvSet("wiki:last-ingest", "2026-08-09T00:00:00.000Z");
    record(h.vault, "knowledge/old.md", "2026-08-08T10:00:00.000Z");
    record(h.vault, "knowledge/new.md", "2026-08-09T10:00:00.000Z");

    const res = await runWikiMaintenance({ ...h, nowFn: () => new Date("2026-08-10T04:00:00.000Z") });

    expect(res.status).toBe("ingested");
    expect(res.files).toBe(1);
    const prompt = h.run.mock.calls[0][1] as string;
    expect(prompt).toContain("knowledge/new.md");
    expect(prompt).not.toContain("knowledge/old.md");
  });

  it("does NOT advance the watermark when the run fails", async () => {
    // Otherwise a single bad night silently loses a day of the record forever.
    const h = harness();
    h.store.kvSet("wiki:last-ingest", "2026-08-09T00:00:00.000Z");
    record(h.vault, "knowledge/new.md", "2026-08-09T10:00:00.000Z");
    h.run.mockRejectedValueOnce(new Error("model exploded"));

    const res = await runWikiMaintenance({ ...h, nowFn: () => new Date("2026-08-10T04:00:00.000Z") });

    expect(res.status).toBe("failed");
    expect(h.store.kvGet("wiki:last-ingest")).toBe("2026-08-09T00:00:00.000Z");
  });

  it("does NOT advance the watermark, or run an agent, when the budget is spent", async () => {
    const h = harness({ allow: false });
    h.store.kvSet("wiki:last-ingest", "2026-08-09T00:00:00.000Z");
    record(h.vault, "knowledge/new.md", "2026-08-09T10:00:00.000Z");

    const res = await runWikiMaintenance({ ...h, nowFn: () => new Date("2026-08-10T04:00:00.000Z") });

    expect(res.status).toBe("budget");
    expect(h.run).not.toHaveBeenCalled();
    expect(h.store.kvGet("wiki:last-ingest")).toBe("2026-08-09T00:00:00.000Z");
  });

  it("leaves the remainder queued when a backlog exceeds the batch", async () => {
    const h = harness();
    h.store.kvSet("wiki:last-ingest", "2026-08-01T00:00:00.000Z");
    for (let i = 1; i <= 5; i++) record(h.vault, `knowledge/f${i}.md`, `2026-08-0${i}T10:00:00.000Z`);

    const res = await runWikiMaintenance({
      ...h, batch: 2, nowFn: () => new Date("2026-08-10T04:00:00.000Z"),
    });

    expect(res.files).toBe(2);
    // Watermark lands on the LAST file handed over, not on "now" — otherwise the three
    // unprocessed files would be skipped for good.
    expect(h.store.kvGet("wiki:last-ingest")).toBe("2026-08-02T10:00:00.000Z");
  });

  it("costs nothing on a quiet night", async () => {
    const h = harness();
    h.store.kvSet("wiki:last-ingest", "2026-08-09T00:00:00.000Z");

    const res = await runWikiMaintenance({ ...h, nowFn: () => new Date("2026-08-10T04:00:00.000Z") });

    expect(res.status).toBe("nothing-new");
    expect(h.run).not.toHaveBeenCalled();
    expect(h.store.kvGet("wiki:last-ingest")).toBe("2026-08-10T04:00:00.000Z");
  });

  it("never offers the wiki to itself as a source", async () => {
    // wiki/ is the output. Feeding it back in would loop the maintainer onto its own pages.
    expect(RECORD_DIRS).not.toContain("wiki");
    const h = harness();
    h.store.kvSet("wiki:last-ingest", "2026-08-09T00:00:00.000Z");
    record(h.vault, "wiki/entities/Thing.md", "2026-08-09T10:00:00.000Z");

    const res = await runWikiMaintenance({ ...h, nowFn: () => new Date("2026-08-10T04:00:00.000Z") });
    expect(res.status).toBe("nothing-new");
  });

  it("tells the maintainer not to file a page per record file", async () => {
    // The whole failure this feature exists to avoid: reproducing the pile as pages.
    const h = harness();
    record(h.vault, "briefs/2026-08-09-morning.md", "2026-08-09T10:00:00.000Z");
    await runWikiMaintenance({ ...h, nowFn: () => new Date("2026-08-10T04:00:00.000Z") });
    const prompt = h.run.mock.calls[0][1] as string;
    expect(prompt).toContain("DO NOT create a page per file");
    expect(prompt).toContain("The record is IMMUTABLE");
  });
});

describe("pickMaintainer", () => {
  it("prefers the research lead, and skips agents that cannot write the wiki", () => {
    // maya is the coordinator and sorts first alphabetically, but holds only Read —
    // so this proves selection filters on capability rather than name or order.
    expect(pickMaintainer(wikiRegistry())).toBe("lina");
  });

  it("refuses a configured agent that lacks the capability", () => {
    // Pinning the wrong agent must not produce a maintainer that cannot write.
    expect(pickMaintainer(wikiRegistry(), "maya")).toBe("lina");
  });

  it("honours a configured agent given by alias", () => {
    expect(pickMaintainer(wikiRegistry(), "analyst")).toBe("lina");
  });

  it("returns null rather than guessing when nothing qualifies", () => {
    const empty = {
      agents: new Map(), departments: new Map(), agentOf: new Map(),
      capabilities: new Map(), coordinator: "none",
    } as never;
    expect(pickMaintainer(empty)).toBeNull();
  });
});
