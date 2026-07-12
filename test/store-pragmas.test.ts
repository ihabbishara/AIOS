// test/store-pragmas.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store/db.js";

describe("Store pragmas", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("opens file databases in WAL mode with foreign keys on", () => {
    dir = mkdtempSync(join(tmpdir(), "aios-pragma-"));
    const path = join(dir, "t.sqlite");
    const store = new Store(path);
    store.kvSet("probe", "1"); // force a write so the mode persists
    store.close();
    // journal_mode=WAL is persistent — a second connection sees it.
    const probe = new DatabaseSync(path);
    const mode = probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    probe.close();
  });

  it(":memory: store still constructs (WAL is a no-op there)", () => {
    dir = mkdtempSync(join(tmpdir(), "aios-pragma-"));
    const store = new Store(":memory:");
    store.kvSet("probe", "1");
    expect(store.kvGet("probe")).toBe("1");
    store.close();
  });
});
