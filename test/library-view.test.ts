// test/library-view.test.ts — read-only workspace browser (spec §4).
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { libraryTree, libraryRead } from "../src/web/library-view.js";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "lib-"));
  root = join(base, "vault");
  outside = join(base, "secrets");
  mkdirSync(join(root, "goals", "2026-08-01-chaser"), { recursive: true });
  mkdirSync(join(root, "knowledge"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "goals", "2026-08-01-chaser", "report.md"), "# Chaser\n\nbody");
  writeFileSync(join(root, "knowledge", "note.md"), "note");
  writeFileSync(join(root, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(outside, "id_rsa"), "PRIVATE KEY");
});

describe("libraryTree", () => {
  it("lists directories before files, each sorted by name", () => {
    const t = libraryTree(root);
    expect(t.map((n) => n.name)).toEqual(["goals", "knowledge", "logo.png"]);
    expect(t[0].dir).toBe(true);
    expect(t[2].dir).toBe(false);
  });

  it("nests children with vault-relative paths", () => {
    const goals = libraryTree(root).find((n) => n.name === "goals")!;
    const dir = goals.children![0];
    expect(dir.path).toBe("goals/2026-08-01-chaser");
    expect(dir.children![0].path).toBe("goals/2026-08-01-chaser/report.md");
  });

  it("reports file sizes", () => {
    const png = libraryTree(root).find((n) => n.name === "logo.png")!;
    expect(png.size).toBe(8);
  });

  it("stops at maxDepth instead of walking forever", () => {
    const goals = libraryTree(root, 1).find((n) => n.name === "goals")!;
    expect(goals.children).toBeUndefined();
  });

  it("returns an empty list for a root that does not exist", () => {
    expect(libraryTree(join(root, "nope"))).toEqual([]);
  });

  // The fixture above happens to sort dirs-first alphabetically too, so it cannot tell the
  // ordering rule from a plain name sort. A file that sorts ahead of every directory can.
  it("keeps directories first even when a file sorts alphabetically ahead", () => {
    writeFileSync(join(root, "aaa.md"), "a");
    expect(libraryTree(root).map((n) => n.name)).toEqual(["goals", "knowledge", "aaa.md", "logo.png"]);
  });

  it("omits dotfiles and dot-directories", () => {
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(join(root, ".obsidian", "workspace.json"), "{}");
    writeFileSync(join(root, ".env"), "TOKEN=secret");
    expect(libraryTree(root).map((n) => n.name)).toEqual(["goals", "knowledge", "logo.png"]);
  });

  it("omits a symlinked file pointing outside the vault", () => {
    symlinkSync(join(outside, "id_rsa"), join(root, "leak.md"));
    expect(libraryTree(root).map((n) => n.name)).toEqual(["goals", "knowledge", "logo.png"]);
  });

  it("does not walk a symlinked directory pointing outside the vault", () => {
    symlinkSync(outside, join(root, "leakdir"));
    const t = libraryTree(root);
    expect(t.map((n) => n.name)).toEqual(["goals", "knowledge", "logo.png"]);
    expect(JSON.stringify(t)).not.toContain("id_rsa");
  });

  it("keeps a symlink that stays inside the vault", () => {
    symlinkSync(join(root, "knowledge"), join(root, "shortcut"));
    const shortcut = libraryTree(root).find((n) => n.name === "shortcut")!;
    expect(shortcut.dir).toBe(true);
    expect(shortcut.children!.map((n) => n.name)).toEqual(["note.md"]);
  });

  it("skips a dangling symlink instead of throwing", () => {
    symlinkSync(join(outside, "gone.md"), join(root, "dangling.md"));
    expect(libraryTree(root).map((n) => n.name)).toEqual(["goals", "knowledge", "logo.png"]);
  });

  it("terminates on a symlink loop inside the vault", () => {
    symlinkSync(root, join(root, "loop"));
    const t = libraryTree(root);
    expect(t.map((n) => n.name)).toContain("loop");
  });
});

describe("libraryRead", () => {
  it("reads a markdown file with a text mime", () => {
    const r = libraryRead(root, "knowledge/note.md");
    expect(r.mime).toBe("text/markdown");
    expect(r.body.toString()).toBe("note");
  });

  it("types images by extension", () => {
    expect(libraryRead(root, "logo.png").mime).toBe("image/png");
  });

  it("rejects a dot-dot escape", () => {
    expect(() => libraryRead(root, "../secrets/id_rsa")).toThrow(/escapes/i);
  });

  it("rejects an absolute path", () => {
    expect(() => libraryRead(root, join(outside, "id_rsa"))).toThrow(/escapes/i);
  });

  it("rejects a symlink pointing outside the vault rather than following it", () => {
    symlinkSync(join(outside, "id_rsa"), join(root, "leak.md"));
    expect(() => libraryRead(root, "leak.md")).toThrow(/escapes/i);
  });

  it("rejects a path whose prefix merely looks like the root", () => {
    // `<root>evil` startsWith `<root>` — the separator is what makes containment correct.
    mkdirSync(`${root}evil`, { recursive: true });
    writeFileSync(join(`${root}evil`, "x.md"), "x");
    expect(() => libraryRead(root, "../vaultevil/x.md")).toThrow(/escapes/i);
  });

  it("rejects a symlinked directory in the middle of the path", () => {
    symlinkSync(outside, join(root, "leakdir"));
    expect(() => libraryRead(root, "leakdir/id_rsa")).toThrow(/escapes/i);
  });

  it("rejects a dot-dot escape hidden behind a real directory", () => {
    expect(() => libraryRead(root, "knowledge/../../secrets/id_rsa")).toThrow(/escapes/i);
  });

  it("rejects the filesystem root", () => {
    expect(() => libraryRead(root, "/")).toThrow(/escapes/i);
  });

  it("refuses the vault root and bare dot paths without escaping the process", () => {
    for (const rel of ["", ".", "./", "knowledge/"]) {
      expect(() => libraryRead(root, rel), `rel=${JSON.stringify(rel)}`).toThrow(/not a file/i);
    }
    expect(() => libraryRead(root, "..")).toThrow(/escapes/i);
  });

  it("refuses a dangling symlink with a plain error rather than an fs failure", () => {
    symlinkSync(join(outside, "gone.md"), join(root, "dangling.md"));
    expect(() => libraryRead(root, "dangling.md")).toThrow(/not a file/i);
  });

  it("falls back to a binary mime for an unknown extension", () => {
    writeFileSync(join(root, "blob.xyz"), "data");
    expect(libraryRead(root, "blob.xyz").mime).toBe("application/octet-stream");
  });
});
