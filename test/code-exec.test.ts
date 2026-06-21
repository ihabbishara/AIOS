// test/code-exec.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  it("confines writes to the task dir only — no world-writable /tmp surface", () => {
    const p = sandboxProfile("/ws/task", "build");
    expect(p).not.toContain("/private/tmp");
    expect(p).not.toContain("(subpath \"/tmp\")");
  });
  it("fail-closed rejects a path that could break out of the SBPL string literal", () => {
    expect(() => sandboxProfile('/ws/ta"sk', "build")).toThrow();
    expect(() => sandboxProfile("/ws/ta\\sk", "build")).toThrow();
    expect(() => sandboxProfile("/ws/ta\nsk", "build")).toThrow();
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
  it("blocks a write to the world-writable /tmp", () => {
    const escape = `/tmp/aios-escape-${process.pid}.txt`;
    expect(() => run(`echo hi > ${escape}`)).toThrow();
    expect(existsSync(escape)).toBe(false);
  });
  it("denies reading a file whose name matches the secret denylist", () => {
    const secret = join(outside, "api-secret.txt");
    writeFileSync(secret, "SUPERSECRET");
    // The `secret` regex deny fires AFTER the broad read-allow (last-match wins), so cat fails.
    expect(() => run(`cat ${secret}`)).toThrow();
  });
});
