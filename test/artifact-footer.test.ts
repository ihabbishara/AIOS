// test/artifact-footer.test.ts — the deterministic "where to find it" block on goal completion.
import { describe, it, expect } from "vitest";
import { artifactFooter } from "../src/engine/artifact-footer.js";
import type { GoalOutcome } from "../src/engine/engine.js";

const outcome = (over: Partial<GoalOutcome> = {}): GoalOutcome => ({
  goal: { slug: "hotel-tv-report", title: "t", id: "g1" } as never,
  ok: true, goalDirName: "2026-08-21-hotel-tv-report", artifactFiles: ["research.md", "deck.md"],
  ...over,
});

describe("artifactFooter", () => {
  it("names the absolute dir, every artifact, the cockpit deep link, and the Obsidian folder", () => {
    const f = artifactFooter(outcome(), { vaultRoot: "/Users/x/AIOS/workspace/AIOS", uiPort: 4280 });
    expect(f).toContain("/Users/x/AIOS/workspace/AIOS/goals/2026-08-21-hotel-tv-report");
    expect(f).toContain("research.md · deck.md");
    expect(f).toContain("http://localhost:4280/#/goals/hotel-tv-report");
    expect(f).toContain("Obsidian");
  });

  it("skips the file line when a goal produced no artifacts, but still says where to look", () => {
    const f = artifactFooter(outcome({ artifactFiles: [] }), { vaultRoot: "/v", uiPort: 4280 });
    expect(f).not.toContain("·");
    expect(f).toContain("/v/goals/2026-08-21-hotel-tv-report");
    expect(f).toContain("#/goals/hotel-tv-report");
  });

  it("stays compact — a footer, not a second report", () => {
    const f = artifactFooter(outcome(), { vaultRoot: "/v", uiPort: 4280 });
    expect(f.length).toBeLessThan(400);
    expect(f.startsWith("\n\n—")).toBe(true);
  });
});
