// test/code-guard.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeGuard, advisoryGuard } from "../src/code/guard.js";

const home = mkdtempSync(join(tmpdir(), "guard-"));
const jail = join(home, "jail");
mkdirSync(jail, { recursive: true });

describe("codeGuard build mode", () => {
  const g = codeGuard(jail, "build");
  it("allows Write inside the jail", () => {
    expect(g.Write({ file_path: join(jail, "src/x.ts") }).ok).toBe(true);
  });
  it("denies Write outside the jail", () => {
    expect(g.Write({ file_path: join(home, "outside.ts") }).ok).toBe(false);
  });
  it("denies Read of a secret even inside-looking paths", () => {
    expect(g.Read({ file_path: "/Users/me/projects/AIOS/.env" }).ok).toBe(false);
  });
  it("allows Read inside the jail", () => {
    expect(g.Read({ file_path: join(jail, "README.md") }).ok).toBe(true);
  });
  it("denies Read outside the jail", () => {
    expect(g.Read({ file_path: join(home, "secrets.txt") }).ok).toBe(false);
  });
  it("denies raw Bash", () => {
    expect(g.Bash({ command: "ls" }).ok).toBe(false);
  });
  it("denies NotebookEdit outside the jail via notebook_path", () => {
    expect(codeGuard(jail, "build").NotebookEdit({ notebook_path: join(home, "x.ipynb") }).ok).toBe(false);
    expect(codeGuard(jail, "build").NotebookEdit({ notebook_path: join(jail, "ok.ipynb") }).ok).toBe(true);
  });
  it("read-scope reads the `path` arg (Grep/Glob), not just file_path", () => {
    expect(codeGuard(jail, "build").Grep({ path: join(jail, "a") }).ok).toBe(true);
    expect(codeGuard(jail, "build").Grep({ path: join(home, "a") }).ok).toBe(false);
  });
  it("denies a write through a symlink that escapes the jail", () => {
    const link = join(jail, "out");
    symlinkSync(home, link); // jail/out -> home (parent)
    expect(codeGuard(jail, "build").Write({ file_path: join(link, "x.ts") }).ok).toBe(false);
  });
});

describe("codeGuard analyze mode", () => {
  const g = codeGuard(jail, "analyze");
  it("denies all writes", () => {
    expect(g.Write({ file_path: join(jail, "x.ts") }).ok).toBe(false);
  });
  it("allows reads inside the analyzed dir", () => {
    expect(g.Read({ file_path: join(jail, "main.ts") }).ok).toBe(true);
  });
});

describe("advisoryGuard", () => {
  const g = advisoryGuard();
  it("denies every filesystem tool", () => {
    for (const t of ["Read", "Write", "Edit", "NotebookEdit", "Grep", "Glob", "Bash"]) {
      expect(g[t]({ file_path: "/anything", command: "x" }).ok).toBe(false);
    }
  });
});
