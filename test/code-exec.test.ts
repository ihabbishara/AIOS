// test/code-exec.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxProfile, jailEnv, runJailed } from "../src/code/exec.js";

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
  it("allows the device sinks so git and npm can run", () => {
    const p = sandboxProfile("/ws/task", "build");
    expect(p).toContain('(allow file-write-data (literal "/dev/null")');
    expect(p).toContain('(literal "/dev/tty")');
    expect(p).toContain('(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))');
  });
  it("device sinks are allowed in analyze mode too (read-only still needs /dev/null)", () => {
    expect(sandboxProfile("/ws/task", "analyze")).toContain('(allow file-write-data (literal "/dev/null")');
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

describe("sandbox network egress", () => {
  it("analyze mode denies network by default", () => {
    expect(sandboxProfile("/ws/task", "analyze")).not.toContain("(allow network*)");
  });
  it("build mode allows network by default (npm installs)", () => {
    expect(sandboxProfile("/ws/task", "build")).toContain("(allow network*)");
  });
  it("explicit net option wins", () => {
    expect(sandboxProfile("/ws/task", "build", { net: "deny" })).not.toContain("(allow network*)");
    expect(sandboxProfile("/ws/task", "analyze", { net: "allow" })).toContain("(allow network*)");
  });
});

describe("sandbox process signals", () => {
  // A jailed build is a process TREE: npm → concurrently → vitest → workers. `children` is
  // direct children only, so a tree-killer signalling a grandchild got EPERM and crashed the
  // run (observed live 2026-08-21 via `concurrently --kill-others`). `pgrp` covers the whole
  // tree — and is only as tight as the jail's process group, which runJailed() isolates.
  it("allows signalling the jail's own process group, not the wider machine", () => {
    const p = sandboxProfile("/ws/task", "build");
    expect(p).toContain("(allow signal (target self))");
    expect(p).toContain("(allow signal (target pgrp))");
    // `others` would let jailed code signal the daemon and every other process on the box.
    expect(p).not.toContain("(target others)");
  });
});

describe("jailEnv scrubs secrets", () => {
  it("drops the daemon's secrets, keeps PATH, points HOME+TMPDIR into the jail", () => {
    const base = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-secret", AWS_SECRET_ACCESS_KEY: "x", AIOS_BUNQ_ENV: "production" } as any;
    const e = jailEnv("/ws/task", base);
    expect(e.PATH).toBe("/usr/bin");
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(e.HOME).toBe("/ws/task");
    expect(e.TMPDIR).toBe("/ws/task/.aios-tmp");
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
  it("denies reading credential stores (.npmrc / .docker/config.json) by absolute path", () => {
    const npmrc = join(outside, ".npmrc");
    writeFileSync(npmrc, "//registry.npmjs.org/:_authToken=NPM_TOKEN");
    expect(() => run(`cat ${npmrc}`)).toThrow();

    const dockerDir = join(outside, ".docker");
    mkdirSync(dockerDir, { recursive: true });
    const dockerCfg = join(dockerDir, "config.json");
    writeFileSync(dockerCfg, '{"auths":{"registry":{"auth":"BASE64CREDS"}}}');
    expect(() => run(`cat ${dockerCfg}`)).toThrow();
  });
});

// The jailed runner's process semantics — the half a profile assertion cannot prove.
describe.runIf(hasSandbox && process.platform === "darwin")("runJailed process tree", () => {
  const task = mkdtempSync(join(tmpdir(), "exec-run-"));

  it("runs a command and returns its output", async () => {
    const r = await runJailed({ taskDir: task, mode: "build" }, "echo hello-jail");
    expect(r.output).toContain("hello-jail");
    expect(r.failed).toBe(false);
  });

  it("reports a non-zero exit as failed, keeping the output", async () => {
    const r = await runJailed({ taskDir: task, mode: "build" }, "echo before; exit 3");
    expect(r.failed).toBe(true);
    expect(r.output).toContain("before");
    expect(r.output).toContain("exit code 3");
  });

  // The live bug: `children` is direct children only, so a tree-killer reaching a grandchild
  // got EPERM. This is the regression test for `(allow signal (target pgrp))`.
  it("can signal a GRANDCHILD, not just a direct child", async () => {
    const r = await runJailed({ taskDir: task, mode: "build" },
      'bash -c "sleep 30 & echo \\$! > gc.pid; sleep 3" & sleep 1; kill $(cat gc.pid) && echo killed-grandchild');
    expect(r.output).toContain("killed-grandchild");
    expect(r.output).not.toContain("Operation not permitted");
  });

  // The jail must NOT be able to reach outside its own group — the property that makes the
  // pgrp allow safe. This test's own process is the thing it must not be able to touch.
  it("is its own process-group leader, so its group excludes the daemon", async () => {
    const r = await runJailed({ taskDir: task, mode: "build" },
      'echo "pgid=$(/bin/bash -c \'echo $PPID\')"; kill -0 ' + process.pid + ' 2>&1 || echo cannot-signal-daemon');
    expect(r.output).toContain("cannot-signal-daemon");
  });

  // The old execFile timeout signalled only the direct child; grandchildren survived holding
  // ports, which is what left orphaned dev servers behind.
  it("kills the whole tree on timeout, orphaning nothing", async () => {
    const r = await runJailed({ taskDir: task, mode: "build", timeoutMs: 1200 },
      'bash -c "sleep 25 & echo \\$! > orphan.pid; sleep 25" & sleep 25');
    expect(r.timedOut).toBe(true);
    expect(r.failed).toBe(true);
    expect(r.output).toContain("process tree was killed");
    // The grandchild must be gone — kill -0 from OUTSIDE the jail is the honest check.
    const pid = Number(readFileSync(join(task, "orphan.pid"), "utf8").trim());
    await new Promise((r2) => setTimeout(r2, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive, `pid ${pid} survived the timeout`).toBe(false);
  }, 15_000);
});
