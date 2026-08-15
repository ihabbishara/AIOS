// test/onboarding-seed.test.ts — the capability catalog is product data that has to be planted
// into the user's agents dir, because that is where the loader reads it from.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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

// The catalog is tracked in BOTH places: templates/ is the PRODUCT copy the seeder plants into
// new installs, and agents/ is the one this repo's own org loads from. They were byte-identical
// until a client-scoped row proved that wrong — a capability naming one operator's client is not
// product data, and shipping it offered a stranger a capability whose guard wants an env var they
// have no reason to own. So the operator's copy is now a SUPERSET: identical product rows, plus
// whatever client rows this machine happens to run. Drift in the product rows is still a bug —
// editing one and not the other silently changes what existing installs get versus new ones.
describe("the two tracked catalogs", () => {
  const parse = (p: string) => parseYaml(readFileSync(p, "utf8")) as Record<string, { labels?: string[] }>;
  const product = parse("templates/_capabilities.yaml");
  const operator = parse("agents/_capabilities.yaml");
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
