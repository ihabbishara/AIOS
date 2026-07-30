// test/onboarding-seed.test.ts — the capability catalog is product data that has to be planted
// into the user's agents dir, because that is where the loader reads it from.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedCapabilities } from "../src/onboarding/seed.js";

let agentsDir: string;
let templatesDir: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "seed-"));
  agentsDir = join(root, "agents");
  templatesDir = join(root, "templates");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, "_capabilities.yaml"), "reading: { tools: [Read] }\n");
});

describe("seedCapabilities", () => {
  it("copies the catalog into an agents dir that has none", () => {
    expect(seedCapabilities(agentsDir, templatesDir)).toBe(true);
    expect(readFileSync(join(agentsDir, "_capabilities.yaml"), "utf8")).toContain("reading");
  });

  it("never overwrites an existing catalog — it may carry hand-edits", () => {
    writeFileSync(join(agentsDir, "_capabilities.yaml"), "mine: { tools: [Glob] }\n");
    expect(seedCapabilities(agentsDir, templatesDir)).toBe(false);
    expect(readFileSync(join(agentsDir, "_capabilities.yaml"), "utf8")).toContain("mine");
  });

  it("creates the agents dir when it does not exist yet", () => {
    const fresh = join(agentsDir, "..", "brand-new");
    expect(existsSync(fresh)).toBe(false);
    expect(seedCapabilities(fresh, templatesDir)).toBe(true);
    expect(existsSync(join(fresh, "_capabilities.yaml"))).toBe(true);
  });

  it("throws a named error when the product catalog is missing", () => {
    expect(() => seedCapabilities(agentsDir, join(templatesDir, "nope")))
      .toThrow(/capability catalog missing/);
  });
});
