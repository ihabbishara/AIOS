// test/publish-allowlist.test.ts — the `files` allowlist in package.json is the only thing keeping
// a client's agent + prompt (agents/clients/halalo.yaml) out of a published tarball. `private: true`
// is NOT that guarantee: npm checks the version against the registry first, so on a rename the
// private flag is the last gate, not the first. Assert on what npm ACTUALLY packs, not on the
// shape of the files array — the array can look right while .gitignore or a new stray dir
// changes the real payload.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const repoRoot = join(import.meta.dirname, "..");

const packedPaths = (): string[] => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
};

describe("npm publish allowlist", () => {
  const files = packedPaths();
  const topLevel = new Set(files.map((p) => p.split("/")[0]));

  // The leak that motivated the allowlist. agents/ is the USER's org, not product data —
  // the runtime creates it and seeds it from templates/ (src/onboarding/seed.ts).
  it("never ships the user's agents directory", () => {
    expect(topLevel.has("agents")).toBe(false);
    expect(files.filter((p) => p.startsWith("agents/"))).toEqual([]);
  });

  it("never ships internal docs, tests, or compiled tests", () => {
    expect(topLevel.has("docs")).toBe(false);
    expect(topLevel.has("test")).toBe(false);
    // tsconfig compiles test/ into dist/, so dist/ must be allowlisted as dist/src/.
    expect(files.filter((p) => p.startsWith("dist/test/"))).toEqual([]);
  });

  it("never ships real secrets", () => {
    expect(files).not.toContain(".env");
    expect(files.filter((p) => p.startsWith("data/"))).toEqual([]);
  });

  // dist/ is BUILD OUTPUT, and tsc never prunes: a renamed module keeps its old file alive there
  // forever, so the tarball shipped a client-named guard that no longer existed in src/. The build
  // script cleans first now; this is the assertion that notices if that ever regresses. Every
  // shipped path must trace back to a real source file.
  it("ships no build artefact whose source is gone", () => {
    const orphans = files
      .filter((p) => p.startsWith("dist/src/") && p.endsWith(".js"))
      .filter((p) => !existsSync(join(repoRoot, p.replace(/^dist\//, "").replace(/\.js$/, ".ts"))));
    expect(orphans).toEqual([]);
  });

  // Product data the runtime cannot boot without: seedCapabilities() throws when it is missing.
  // Unconditional — this one ships straight from the source tree.
  it("still ships the capability catalog", () => {
    expect(files).toContain("templates/_capabilities.yaml");
  });

  // dist/ is build output, so a fresh clone legitimately has none and npm pack cannot include
  // what is not there. Asserting it unconditionally made the suite fail on any unbuilt checkout
  // — caught by running this suite inside a clone, where it is the only thing that failed.
  it.skipIf(!existsSync(join(repoRoot, "dist")))("ships the runtime entrypoint once built", () => {
    expect(files).toContain("dist/src/index.js");
  });
}, 60_000);

// The catalogue SHIPS, and seedCapabilities() copies it into every new install — so a row here is
// a row in a stranger's org. A client-scoped one offers them a capability whose guard demands an
// env var for a client they have never heard of. The operator's own client rows belong in their
// agents/_capabilities.yaml, which does not ship.
describe("shipped capability catalogue", () => {
  const catalogue = parseYaml(
    readFileSync(join(repoRoot, "templates", "_capabilities.yaml"), "utf8"),
  ) as Record<string, { labels?: string[] }>;

  it("carries no client-scoped capability", () => {
    const clientScoped = Object.entries(catalogue)
      .filter(([, def]) => (def?.labels ?? []).some((l) => l.startsWith("client.")))
      .map(([name]) => name);
    expect(clientScoped).toEqual([]);
  });

  // Non-vacuity: proves the file parsed and the labels field is actually being read.
  it("still defines product capabilities with labels", () => {
    const labelled = Object.values(catalogue).filter((d) => (d?.labels ?? []).length > 0);
    expect(labelled.length).toBeGreaterThan(0);
  });
});
