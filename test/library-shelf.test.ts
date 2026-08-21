// test/library-shelf.test.ts — buildLibraryShelf: the Library's front door. The shelf's whole
// claim is "deliverables, not machinery", so what these tests pin is the boundary: engine
// working residue and the goal brief stay OFF the shelf, unfinished goals stay off, the
// internal record dirs (jobs/, briefs/, wiki/…) are never promoted, and the headline is the
// terminal node's artifact — the file the plan existed to produce.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type GoalStatus } from "../src/store/db.js";
import { buildLibraryShelf, isWorkingFile } from "../src/web/library-shelf.js";

let vault: string;
let store: Store;

const GOAL_DIR = "2026-08-10-hotel-tv-report";

function addGoal(over: Partial<{ id: string; slug: string; status: GoalStatus; goal_dir: string | null }> = {}) {
  store.insertGoal({
    id: over.id ?? "g1", slug: over.slug ?? "hotel-tv-report", title: "Hotel TV report",
    request: "how do hotels get TV", department: "research", lead: "clio",
    origin_channel: "web", origin_chat_id: "c1", status: over.status ?? "done",
    project_dir: null, goal_dir: over.goal_dir === undefined ? GOAL_DIR : over.goal_dir,
    plan_summary: "", replans_used: 0, chain_depth: 0, error: null, legacy: 0,
  });
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "shelf-"));
  store = new Store(":memory:");
  const dir = join(vault, "goals", GOAL_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "goal.md"), "# the brief");
  writeFileSync(join(dir, "facts.md"), "# facts");
  writeFileSync(join(dir, "report.md"), "# the report");
  // Engine residue, both namings: attempt-prefixed and the older bare rounds.
  writeFileSync(join(dir, "report-a1-v1.md"), "draft");
  writeFileSync(join(dir, "report-a1-review-1.md"), "critic notes");
  writeFileSync(join(dir, "report-a2-denied.md"), "refused attempt");
  writeFileSync(join(dir, "report-v1.md"), "legacy draft");
  writeFileSync(join(dir, "report-review-2.md"), "legacy critic");
});

function planNodes() {
  store.insertNodes("g1", [
    { node_key: "facts", type: "run", agent: "a", critic: null, brief: "", depends_on: [], max_rounds: 1 },
    { node_key: "report", type: "loop", agent: "a", critic: "c", brief: "", depends_on: ["facts"], max_rounds: 3 },
  ]);
  store.setNodeArtifact("g1", "facts", "facts.md");
  store.setNodeArtifact("g1", "report", "report.md");
  store.updateNodeStatus("g1", "facts", "done");
  store.updateNodeStatus("g1", "report", "done");
}

describe("buildLibraryShelf — works", () => {
  it("shelves a done goal's deliverables and hides the brief and the engine residue", () => {
    addGoal(); planNodes();
    const { works } = buildLibraryShelf(store, vault);
    expect(works).toHaveLength(1);
    const names = works[0].files.map((f) => f.name).sort();
    expect(names).toEqual(["facts.md", "report.md"]);
    expect(works[0].department).toBe("research");
  });

  it("headline is the TERMINAL node's artifact, not just any node's", () => {
    addGoal(); planNodes();
    const { works } = buildLibraryShelf(store, vault);
    expect(works[0].headline).toBe("report.md"); // facts.md is a dependency, not the point
  });

  it("a headline whose file was cleaned off disk comes back null, never dangling", () => {
    addGoal();
    store.insertNodes("g1", [
      { node_key: "summary", type: "run", agent: "a", critic: null, brief: "", depends_on: [], max_rounds: 1 },
    ]);
    store.setNodeArtifact("g1", "summary", "vanished.md");
    store.updateNodeStatus("g1", "summary", "done");
    const { works } = buildLibraryShelf(store, vault);
    expect(works[0].headline).toBeNull();
  });

  it("running goals and goals with nothing on disk stay off the shelf", () => {
    addGoal({ status: "running" });
    addGoal({ id: "g2", slug: "empty", status: "done", goal_dir: "2026-08-11-empty" });
    addGoal({ id: "g3", slug: "dirless", status: "done", goal_dir: null });
    const { works } = buildLibraryShelf(store, vault);
    expect(works).toHaveLength(0);
  });

  it("a failed goal WITH output is still shown — the work exists and its status says failed", () => {
    addGoal({ status: "failed" }); planNodes();
    const { works } = buildLibraryShelf(store, vault);
    expect(works).toHaveLength(1);
    expect(works[0].status).toBe("failed");
  });
});

describe("buildLibraryShelf — docs", () => {
  it("lists standalone docs with titles read from the doc, and never the internal record", () => {
    mkdirSync(join(vault, "reports"), { recursive: true });
    writeFileSync(join(vault, "reports", "ui-bugs.md"), "---\ntype: report\n---\n\n# Two UI bugs diagnosed\n\nbody");
    // Nested one level, like finance/idama/ — still a doc.
    mkdirSync(join(vault, "finance", "idama"), { recursive: true });
    writeFileSync(join(vault, "finance", "idama", "q3.csv"), "a,b\n1,2\n");
    // Internal record dirs must never be promoted onto the shelf.
    mkdirSync(join(vault, "jobs"), { recursive: true });
    writeFileSync(join(vault, "jobs", "run-log.md"), "# internal");
    mkdirSync(join(vault, "wiki", "concepts"), { recursive: true });
    writeFileSync(join(vault, "wiki", "concepts", "SMATV.md"), "# concept page");

    const { docs } = buildLibraryShelf(store, vault);
    const byName = new Map(docs.map((d) => [d.name, d]));
    expect(byName.get("ui-bugs.md")?.title).toBe("Two UI bugs diagnosed");
    expect(byName.get("ui-bugs.md")?.folder).toBe("reports");
    expect(byName.get("q3.csv")?.path).toBe("finance/idama/q3.csv");
    expect(byName.has("run-log.md")).toBe(false);
    expect(byName.has("SMATV.md")).toBe(false);
  });

  it("a missing vault answers empty rather than throwing", () => {
    expect(buildLibraryShelf(store, join(vault, "not-there"))).toEqual({ works: [], docs: [] });
  });
});

describe("isWorkingFile — the residue boundary", () => {
  it("catches both engine namings and leaves real deliverables alone", () => {
    for (const residue of [
      "report-a1-v1.md", "report-a12-review-3.md", "report-a2-denied.md",
      "verify-a1-run-2.md", "impl-a1-fix-1.md", "report-v1.md", "report-review-2.md",
    ]) expect(isWorkingFile(residue), residue).toBe(true);
    for (const real of ["report.md", "deck.pdf", "final-audit.md", "deck-md-part2.md", "ASSEMBLY.md", "v2-notes.md"]) {
      expect(isWorkingFile(real), real).toBe(false);
    }
  });
});
