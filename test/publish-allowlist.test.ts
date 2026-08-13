// test/publish-allowlist.test.ts — the `files` allowlist in package.json is the only thing keeping
// a client's agent + prompt (agents/clients/halalo.yaml) out of a published tarball. `private: true`
// is NOT that guarantee: npm checks the version against the registry first, so on a rename the
// private flag is the last gate, not the first. Assert on what npm ACTUALLY packs, not on the
// shape of the files array — the array can look right while .gitignore or a new stray dir
// changes the real payload.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

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

  // Product data the runtime cannot boot without: seedCapabilities() throws when it is missing.
  it("still ships the capability catalog and the runtime entrypoint", () => {
    expect(files).toContain("templates/_capabilities.yaml");
    expect(files).toContain("dist/src/index.js");
  });
}, 60_000);
