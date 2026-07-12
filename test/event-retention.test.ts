// test/event-retention.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store/db.js";

describe("event retention", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("pruneEvents deletes only rows older than the cutoff", () => {
    dir = mkdtempSync(join(tmpdir(), "aios-retention-"));
    const path = join(dir, "t.sqlite");
    new Store(path).close(); // create schema
    // addEvent stamps its own timestamp — insert aged rows via a probe connection.
    const probe = new DatabaseSync(path);
    const ins = probe.prepare("INSERT INTO events (ts, payload) VALUES (?, ?)");
    ins.run("2026-01-01T00:00:00.000Z", JSON.stringify({ type: "chat.in" }));
    ins.run("2026-07-01T00:00:00.000Z", JSON.stringify({ type: "chat.in" }));
    probe.close();

    const store = new Store(path);
    const n = store.pruneEvents("2026-04-01T00:00:00.000Z");
    expect(n).toBe(1);
    expect(store.listEvents(0, 100)).toHaveLength(1);
    expect(store.listEvents(0, 100)[0].ts).toBe("2026-07-01T00:00:00.000Z");
    // idempotent
    expect(store.pruneEvents("2026-04-01T00:00:00.000Z")).toBe(0);
    store.close();
  });
});
