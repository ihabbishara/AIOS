// test/onboarding-seed.test.ts — the capability catalog is product data that has to be planted
// into the user's agents dir, because that is where the loader reads it from.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { seedCapabilities } from "../src/onboarding/seed.js";
import { FIXTURE_AGENTS_DIR } from "./fixtures/org.js";

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

// templates/ is the PRODUCT catalogue the seeder plants into new installs. It used to be
// byte-compared against agents/_capabilities.yaml, but agents/ is user data now and absent from a
// fresh clone — that comparison failed the moment it was cloned. The tracked pair is now the
// product copy and the SUITE's fixture copy, and the drift risk is the same one: editing the
// product catalogue without the fixture changes what new installs get versus what the tests
// assert, silently. Client-scoped rows still belong in neither.
describe("the two tracked catalogs", () => {
  const parse = (p: string) => parseYaml(readFileSync(p, "utf8")) as Record<string, { labels?: string[] }>;
  const product = parse("templates/_capabilities.yaml");
  const operator = parse(join(FIXTURE_AGENTS_DIR, "_capabilities.yaml"));
  const isClientScoped = (d?: { labels?: string[] }) => (d?.labels ?? []).some((l) => l.startsWith("client."));

  it("agree on every product capability", () => {
    for (const [name, def] of Object.entries(product)) {
      expect(operator[name], `${name} missing from agents/`).toBeDefined();
      expect(operator[name], `${name} drifted between the two catalogs`).toEqual(def);
    }
  });

  it("differ only by client-scoped rows", () => {
    const extra = Object.keys(operator).filter((k) => !(k in product));
    expect(extra.filter((k) => !isClientScoped(operator[k]))).toEqual([]);
  });

  // Non-vacuity: the product copy must never be the one carrying a client row.
  it("keep client rows out of the product copy", () => {
    expect(Object.entries(product).filter(([, d]) => isClientScoped(d)).map(([k]) => k)).toEqual([]);
  });
});
