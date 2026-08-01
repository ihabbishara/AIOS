// test/library-view.test.ts — read-only workspace browser (spec §4).
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { libraryTree, libraryRead, MAX_READ_BYTES, type LibraryNode } from "../src/web/library-view.js";

let root: string;
let outside: string;

/** chmod is advisory for root and a no-op on Windows, so an unreadable fixture would pass for
 *  the wrong reason there — better skipped than green. */
const CAN_LOCK = process.platform !== "win32" && process.getuid?.() !== 0;
const locked: string[] = [];
afterEach(() => { while (locked.length) chmodSync(locked.pop()!, 0o700); });

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

  // An unclamped depth is what makes a loop unbounded, so the ceiling is the load-bearing part:
  // measured on a plain deep chain, because a fixture that actually loops would hang the worker
  // rather than fail if the clamp regressed.
  it("clamps a caller's depth rather than walking as deep as it is told", () => {
    let dir = root;
    for (let i = 0; i < 20; i++) dir = join(dir, `d${i}`);
    mkdirSync(dir, { recursive: true });
    const depthOf = (nodes: LibraryNode[]): number =>
      nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((n) => depthOf(n.children ?? [])));
    expect(depthOf(libraryTree(root, Infinity))).toBe(16);
  });

  // Removing the readdirSync try/catch leaves every other test green — this is the one that
  // turns a regression into a red test instead of an unhandled throw and a 500.
  it.skipIf(!CAN_LOCK)("keeps the tree when a subdirectory cannot be read", () => {
    const blocked = join(root, "locked");
    mkdirSync(blocked);
    writeFileSync(join(blocked, "inner.md"), "x");
    chmodSync(blocked, 0o000);
    locked.push(blocked);
    const t = libraryTree(root);
    expect(t.map((n) => n.name)).toEqual(["goals", "knowledge", "locked", "logo.png"]);
    expect(t.find((n) => n.name === "locked")!.children).toEqual([]);
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
    // Also when the leaf is absent: the middle symlink still decides where this lands, and
    // "not a file" here would report on what does not exist outside the vault.
    expect(() => libraryRead(root, "leakdir/absent.md")).toThrow(/escapes/i);
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
    // Judged on where it points, not on whether the target is there: one that leaves the vault
    // is an escape even while broken, and one that stays inside is simply missing.
    symlinkSync(join(outside, "gone.md"), join(root, "dangling.md"));
    symlinkSync(join(root, "knowledge", "gone.md"), join(root, "inside.md"));
    expect(() => libraryRead(root, "dangling.md")).toThrow(/escapes/i);
    expect(() => libraryRead(root, "inside.md")).toThrow(/not a file/i);
  });

  it("falls back to a binary mime for an unknown extension", () => {
    writeFileSync(join(root, "blob.xyz"), "data");
    expect(libraryRead(root, "blob.xyz").mime).toBe("application/octet-stream");
  });

  // If the tree will not list it, the endpoint must not serve it. An Obsidian vault is routinely
  // a git repo, so .env and .git/config are the realistic case, not an exotic one.
  it("refuses a dotfile the tree would never list", () => {
    writeFileSync(join(root, ".env"), "ANTHROPIC_TOKEN=sk-secret-123");
    expect(() => libraryRead(root, ".env")).toThrow(/hidden/i);
  });

  it("refuses a dot-leading directory segment, not just a dot-leading file name", () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "url = https://user:pw@example.com/x.git");
    expect(() => libraryRead(root, ".git/config")).toThrow(/hidden/i);
  });

  it("refuses a hidden file reached through an ordinary-looking symlink", () => {
    writeFileSync(join(root, ".env"), "ANTHROPIC_TOKEN=sk-secret-123");
    symlinkSync(join(root, ".env"), join(root, "notes.md"));
    expect(() => libraryRead(root, "notes.md")).toThrow(/hidden/i);
  });

  it("answers the same for a hidden path that does not exist — no existence oracle", () => {
    expect(() => libraryRead(root, ".ssh/id_rsa")).toThrow(/hidden/i);
  });

  // SVG is active content in the cockpit's own origin and these files are agent-written, so an
  // inline image type here is stored XSS. It must fall through to the download path.
  it("does not type an .svg as an inline image", () => {
    writeFileSync(join(root, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>');
    expect(libraryRead(root, "diagram.svg").mime).toBe("application/octet-stream");
  });

  it("refuses a file over the read cap instead of buffering it", () => {
    const big = join(root, "big.bin");
    writeFileSync(big, "");
    truncateSync(big, MAX_READ_BYTES + 1); // sparse: no multi-megabyte write, real reported size
    expect(() => libraryRead(root, "big.bin")).toThrow(/too large/i);
    truncateSync(big, MAX_READ_BYTES); // the cap itself still reads — the bound is `>`, not `>=`
    expect(libraryRead(root, "big.bin").body.length).toBe(MAX_READ_BYTES);
  });

  it("reports a missing workspace plainly instead of an fs error carrying its absolute path", () => {
    const gone = join(root, "nope");
    expect(() => libraryRead(gone, "note.md")).toThrow(/workspace is not available/i);
    expect(() => libraryRead(gone, "note.md")).not.toThrow(/ENOENT/);
  });

  it("rejects a link out of the vault identically whether or not its target exists", () => {
    symlinkSync(join(outside, "id_rsa"), join(root, "present.md"));
    symlinkSync(join(outside, "absent.md"), join(root, "gone.md"));
    expect(() => libraryRead(root, "present.md")).toThrow(/escapes/i);
    // Same verdict for the absent target: "not a file" here would confirm what is NOT out there.
    expect(() => libraryRead(root, "gone.md")).toThrow(/escapes/i);
  });
});
