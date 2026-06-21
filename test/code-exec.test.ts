// test/code-exec.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxProfile } from "../src/code/exec.js";

const hasSandbox = (() => {
  try { execFileSync("which", ["sandbox-exec"]); return true; } catch { return false; }
})();

describe("sandboxProfile (pure)", () => {
  it("allows writes under the task dir and denies the rest", () => {
    const p = sandboxProfile("/ws/task", "build");
    expect(p).toContain("(allow file-write* (subpath \"/ws/task\")");
    expect(p).toContain("(deny default)");
  });
  it("analyze mode emits no file-write allow", () => {
    expect(sandboxProfile("/ws/task", "analyze")).not.toContain("file-write* (subpath \"/ws/task\")");
  });
});

// OS-level escape proof — only meaningful on darwin with sandbox-exec present.
describe.runIf(hasSandbox && process.platform === "darwin")("sandbox-exec enforcement", () => {
  const task = mkdtempSync(join(tmpdir(), "exec-task-"));
  const outside = mkdtempSync(join(tmpdir(), "exec-out-"));
  const run = (cmd: string) => {
    const prof = sandboxProfile(task, "build");
    return execFileSync("sandbox-exec", ["-p", prof, "/bin/bash", "-lc", cmd], { cwd: task });
  };

  it("permits an in-jail write", () => {
    run(`echo hi > ${join(task, "ok.txt")}`);
    expect(readFileSync(join(task, "ok.txt"), "utf8")).toContain("hi");
  });
  it("blocks an out-of-jail write", () => {
    expect(() => run(`echo hi > ${join(outside, "bad.txt")}`)).toThrow();
    expect(existsSync(join(outside, "bad.txt"))).toBe(false);
  });
});
