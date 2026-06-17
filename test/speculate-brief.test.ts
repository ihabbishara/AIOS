import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import type { JobRow } from "../src/store/db.js";
import { assembleBrief, renderBriefNote, isEmptyBrief } from "../src/heartbeat/briefs.js";
import { localParts } from "../src/heartbeat/clock.js";

const NOW = "2026-06-17T07:30:00.000Z"; // morning; same local date as the speculate stamp
const TODAY = localParts(new Date(NOW)).date;

/** Insert a job row directly so the brief's getJob(id) can resolve status. */
function insertJob(s: Store, id: string, slug: string, status: JobRow["status"]) {
  s.insertJob({
    id, slug, title: slug, playbook: "research-report", request: "q",
    project_dir: null, channel: "system", chat_id: "speculate", status, error: null,
  });
}

function seedSpeculate(s: Store, date: string, tasks: Array<{ title: string; slug: string; id: string }>) {
  s.kvSet("speculate:latest", JSON.stringify({ date, tasks }));
}

describe("speculate section in the morning brief", () => {
  it("resolves done/failed/running status + a report ref and renders the section", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    insertJob(s, "id-fail", "beta", "failed");
    insertJob(s, "id-run", "gamma", "running");
    seedSpeculate(s, TODAY, [
      { title: "Alpha", slug: "alpha", id: "id-done" },
      { title: "Beta", slug: "beta", id: "id-fail" },
      { title: "Gamma", slug: "gamma", id: "id-run" },
    ]);
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toEqual([
      { title: "Alpha", status: "done", ref: `jobs/${TODAY}-alpha/report.md` },
      { title: "Beta", status: "failed", ref: null },
      { title: "Gamma", status: "running", ref: null },
    ]);
    const note = renderBriefNote(data, "narration");
    expect(note).toMatch(/## Speculate — researched overnight/);
    expect(note).toMatch(new RegExp(`Alpha — jobs/${TODAY}-alpha/report.md`));
    expect(note).toMatch(/Beta — failed/);
    expect(note).toMatch(/Gamma — still running/);
  });

  it("evening brief never includes the speculate section", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    seedSpeculate(s, TODAY, [{ title: "Alpha", slug: "alpha", id: "id-done" }]);
    const data = assembleBrief(s, "evening", NOW, null);
    expect(data.speculateResults).toBeUndefined();
    expect(renderBriefNote(data, "n")).not.toMatch(/## Speculate/);
  });

  it("omits a stale-dated speculate:latest", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    seedSpeculate(s, "2020-01-01", [{ title: "Alpha", slug: "alpha", id: "id-done" }]);
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toBeUndefined();
  });

  it("a morning with only speculate results is not 'empty' (so it narrates)", () => {
    const s = new Store(":memory:");
    insertJob(s, "id-done", "alpha", "done");
    seedSpeculate(s, TODAY, [{ title: "Alpha", slug: "alpha", id: "id-done" }]);
    const data = assembleBrief(s, "morning", NOW, null);
    expect(isEmptyBrief(data)).toBe(false);
  });

  it("malformed speculate:latest is omitted (no throw)", () => {
    const s = new Store(":memory:");
    s.kvSet("speculate:latest", "not json {");
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toBeUndefined();
  });

  it("treats a task whose job row is missing as still running", () => {
    const s = new Store(":memory:");
    seedSpeculate(s, TODAY, [{ title: "Ghost", slug: "ghost", id: "id-missing" }]); // never inserted
    const data = assembleBrief(s, "morning", NOW, null);
    expect(data.speculateResults).toEqual([{ title: "Ghost", status: "running", ref: null }]);
  });
});
