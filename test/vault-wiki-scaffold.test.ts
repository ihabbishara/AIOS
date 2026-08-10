// test/vault-wiki-scaffold.test.ts — every install is provisioned with the LLM Wiki
// scaffold, and re-provisioning never destroys it.
//
// init() runs on EVERY boot (boot.ts), so the clobber test below is the one that
// actually protects user data: an unconditional write would erase an accumulated
// wiki on restart, silently, with no error anywhere.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultWriter } from "../src/vault/writer.js";
import { WIKI_DIRS, seedFiles } from "../src/vault/wiki-schema.js";

function fresh(): { w: VaultWriter; root: string } {
  const w = new VaultWriter(mkdtempSync(join(tmpdir(), "vault-")), "AIOS");
  return { w, root: w.root };
}

describe("wiki scaffold provisioning", () => {
  it("gives a brand-new install the schema, catalog, log and wiki folders", () => {
    const { w, root } = fresh();
    w.init("2026-01-31");
    for (const dir of WIKI_DIRS) {
      expect(statSync(join(root, dir)).isDirectory()).toBe(true);
    }
    for (const name of ["CLAUDE.md", "index.md", "log.md"]) {
      expect(existsSync(join(root, name))).toBe(true);
    }
    // The record dirs still get made — the wiki is additive, not a replacement.
    for (const dir of ["knowledge", "daily", "notes"]) {
      expect(statSync(join(root, dir)).isDirectory()).toBe(true);
    }
  });

  it("NEVER overwrites a wiki that already exists", () => {
    // The failure this guards: boot → init() → schema and log reset to seed, and an
    // accumulated index silently emptied.
    const { w, root } = fresh();
    w.init("2026-01-31");
    const edited = "# Index\n\n## Entities\n- [[Algeria]] — the market. (7 sources)\n";
    writeFileSync(join(root, "index.md"), edited);
    writeFileSync(join(root, "log.md"), "# Log\n\n## [2026-02-02] ingest | something real\n");
    writeFileSync(join(root, "CLAUDE.md"), "# Schema\n\nlocally amended\n");

    w.init("2026-02-03"); // a later boot

    expect(readFileSync(join(root, "index.md"), "utf8")).toBe(edited);
    expect(readFileSync(join(root, "log.md"), "utf8")).toContain("something real");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# Schema\n\nlocally amended\n");
  });

  it("restores only the piece that is missing, leaving the rest untouched", () => {
    // A user may delete one file; init should heal that without resetting the others.
    const { w, root } = fresh();
    w.init("2026-01-31");
    const keep = "# Log\n\n## [2026-02-02] note | mine\n";
    writeFileSync(join(root, "log.md"), keep);
    writeFileSync(join(root, "index.md"), "# Index\n\ncustom\n");
    unlinkSync(join(root, "index.md"));

    w.init("2026-02-03");

    expect(readFileSync(join(root, "log.md"), "utf8")).toBe(keep);
    expect(readFileSync(join(root, "index.md"), "utf8")).toContain("Content catalog");
  });

  it("dates the initial log entry with the LOCAL date it was given", () => {
    // Vault artifacts use the user's calendar day, not UTC's — a UTC stamp files a
    // 01:25-local entry into the previous day at any positive offset.
    const { w, root } = fresh();
    w.init("2026-01-31");
    expect(readFileSync(join(root, "log.md"), "utf8")).toContain("## [2026-01-31] note | Wiki initialized");
  });
});

describe("the seeded schema", () => {
  const body = (name: string): string => {
    const found = seedFiles("2026-01-31").find(([rel]) => rel === name);
    if (!found) throw new Error(`no seed for ${name}`);
    return found[1];
  };

  it("states the two invariants that keep AIOS inside its own folder", () => {
    const schema = body("CLAUDE.md");
    expect(schema).toContain("Never modify the record");
    expect(schema).toContain("Never write outside this directory");
  });

  it("documents the log prefix that makes the log greppable", () => {
    // The convention is only worth having if it is stated where the maintainer reads it.
    expect(body("CLAUDE.md")).toContain("## [2026-01-31] ingest |");
    expect(body("log.md")).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] \w+ \| /m);
  });

  it("tells the maintainer to synthesize across runs rather than page-per-artifact", () => {
    // Without this the wiki reproduces the pile it exists to replace: 71.5% of a real
    // vault is per-run artifacts and jobs/ (162 docs) was never retrieved once.
    expect(body("CLAUDE.md")).toContain("Do not create one wiki page per run artifact");
  });

  it("warns against wrapping a wikilink across lines", () => {
    // Observed on the maintainer's first live pass: a hard-wrapped [[Page\n  Name]] renders
    // as literal text and the link is lost with no error anywhere.
    expect(body("CLAUDE.md")).toContain("NEVER wrap a wikilink across a line break");
  });

  it("ships a catalog with every category the schema names", () => {
    const index = body("index.md");
    for (const section of ["Sources", "Entities", "Concepts", "Topics", "Analyses"]) {
      expect(index).toContain(`## ${section}`);
    }
  });
});
