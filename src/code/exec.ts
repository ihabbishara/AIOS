// src/code/exec.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { realpathSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ENV_ALLOWLIST, sbplSecretDenyLines } from "../kernel/secrets.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Minimal, secret-free environment for a jailed command. Allowlist, not the daemon's full env. */
export function jailEnv(taskDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const jailTmp = join(taskDir, ".aios-tmp");
  const env: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOWLIST) if (base[k] !== undefined) env[k] = base[k];
  env.HOME = taskDir;               // tools resolve ~ into the jail, not the real home (no real ~/.npmrc etc.)
  env.TMPDIR = jailTmp; env.TMP = jailTmp; env.TEMP = jailTmp;
  return env;
}

/** macOS sandbox profile (SBPL). Deny-default; broad read minus the secret denylist;
 *  write only under the task dir (build), none (analyze). Later rules override earlier
 *  for the same operation, so the secret denies must come AFTER the broad read allow. */
export function sandboxProfile(
  taskDir: string,
  mode: "build" | "analyze",
  opts?: { net?: "allow" | "deny" },
): string {
  // Resolve symlinks so macOS /var/folders -> /private/var/folders works in SBPL subpath matching.
  let realDir = taskDir;
  try { realDir = realpathSync(taskDir); } catch { /* non-existent dirs are used in unit tests */ }
  // Fail-closed: a path with a quote/backslash/newline would break out of the SBPL string
  // literal and inject arbitrary sandbox rules. Reject the exact value we interpolate.
  if (/["\\\n]/.test(realDir)) throw new Error(`unsafe workspace path for sandbox profile: ${realDir}`);
  // Writes confined to the task dir ONLY — no world-writable /tmp surface. Toolchains that
  // need scratch space get a TMPDIR under the jail (see buildCodeServer), already covered here.
  const writeAllow = mode === "build"
    ? `(allow file-write* (subpath "${realDir}"))`
    : "";
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // A jailed build is a process TREE (npm → concurrently → vitest → workers), and `children`
    // is DIRECT children only: a tree-killer reaching a grandchild got EPERM and took the run
    // down with it (observed live 2026-08-21 through `concurrently --kill-others`). `pgrp`
    // covers the whole tree — and stays tight because runJailed() makes the jail its own
    // process-group leader, so "my group" is exactly "my jailed tree". Never `others`: that
    // would let jailed code signal the daemon and everything else on the machine.
    "(allow signal (target self))",
    "(allow signal (target children))",
    "(allow signal (target pgrp))",
    // Egress: analyze (read-only audit) needs no network → deny-default covers it.
    // Build keeps network for package installs unless AIOS_SANDBOX_NET=deny.
    (opts?.net ?? (mode === "build" ? "allow" : "deny")) === "allow" ? "(allow network*)" : "",
    "(allow file-read*)",
    // Device sinks: git and most npm scripts open /dev/null for read+write and fail hard
    // without it ("fatal: could not open '/dev/null'"). Writing to a sink leaks nothing,
    // and the filesystem write surface stays confined to the task dir.
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/tty"))',
    // secrets win (last-match): never readable inside the sandbox. Deny lines
    // live in the unified secrets module (src/kernel/secrets.ts) — superset of
    // isSecretPath's families plus credential stores a shell could `cat` by
    // absolute path. Scoped to path families, so toolchain reads stay allowed.
    ...sbplSecretDenyLines(),
    writeAllow,
  ].filter(Boolean).join("\n");
}

/** Output ceiling for one jailed command — the reply is buffered in the daemon's memory. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Grace between SIGTERM and SIGKILL on timeout, so a runner can flush before it dies. */
const KILL_GRACE_MS = 2_000;

export interface JailResult { output: string; failed: boolean; timedOut: boolean }

/**
 * Run one command in the jail, as its OWN process-group leader.
 *
 * `detached` is the load-bearing bit, for two reasons:
 *  - It makes `(allow signal (target pgrp))` safe. Without it the jail inherits the DAEMON's
 *    process group, and "signal my own group" would include the daemon itself — jailed code
 *    could kill its supervisor. As a group leader, the jail's group is exactly its own tree.
 *  - It makes the timeout reap the whole tree. The old execFile timeout signalled only the
 *    direct child, leaving grandchildren (dev servers, watchers) orphaned and holding ports —
 *    the aborted dev sessions odin found in the spike's dev.log.
 *
 * Note execFile CANNOT do this: it builds its own spawn options and silently drops `detached`.
 */
export function runJailed(
  ctx: { taskDir: string; mode: "build" | "analyze"; timeoutMs?: number },
  cmd: string,
): Promise<JailResult> {
  return new Promise((resolve) => {
    const profile = sandboxProfile(
      ctx.taskDir, ctx.mode,
      process.env.AIOS_SANDBOX_NET === "deny" ? { net: "deny" } : undefined,
    );
    // Temp dir lives INSIDE the jail so toolchains have scratch space without a
    // world-writable /tmp allow. It's under taskDir, so the subpath write rule covers it.
    const jailTmp = join(ctx.taskDir, ".aios-tmp");
    mkdirSync(jailTmp, { recursive: true });
    const child = spawn(
      "sandbox-exec", ["-p", profile, "/bin/bash", "-lc", cmd],
      {
        cwd: ctx.taskDir,
        // Curated allowlist env — the daemon's secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) never
        // reach the jailed shell, so a build can't read them from the environment and exfil.
        env: jailEnv(ctx.taskDir),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    /** Signal the whole jailed tree. Negative pid = process group, which the child leads. */
    const killTree = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* already gone */ } }
    };

    let out = "", errOut = "", bytes = 0, truncated = false, timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const collect = (buf: Buffer, onto: "out" | "err") => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const room = MAX_OUTPUT_BYTES - bytes;
      const s = buf.length > room ? buf.subarray(0, room).toString() : buf.toString();
      bytes += Math.min(buf.length, room);
      if (onto === "out") out += s; else errOut += s;
      // Past the ceiling the run is unbounded output, not work — stop it rather than let the
      // daemon buffer without limit (the maxBuffer safety execFile used to provide).
      if (bytes >= MAX_OUTPUT_BYTES && !truncated) { truncated = true; killTree("SIGKILL"); }
    };
    child.stdout.on("data", (b: Buffer) => collect(b, "out"));
    child.stderr.on("data", (b: Buffer) => collect(b, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      graceTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
    }, ctx.timeoutMs ?? 120_000);

    const settle = (failed: boolean, note?: string) => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const body = `${out}${errOut ? `\n[stderr]\n${errOut}` : ""}`.trim();
      const parts = [note, truncated ? `[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : "", body];
      resolve({ output: parts.filter(Boolean).join("\n") || "(no output)", failed, timedOut });
    };
    // 'close' (not 'exit') — it waits for the pipes to drain, so no trailing output is lost.
    child.on("close", (code, signal) => {
      if (timedOut) return settle(true, `Command timed out after ${ctx.timeoutMs ?? 120_000}ms and the process tree was killed.`);
      if (code === 0) return settle(false);
      settle(true, `Command failed (${signal ? `killed by ${signal}` : `exit code ${code}`}).`);
    });
    child.on("error", (e) => settle(true, `Command could not start (${e.message}).`));
  });
}

export function buildCodeServer(ctx: { taskDir: string; mode: "build" | "analyze"; timeoutMs?: number }) {
  // Fail-closed: a missing dir would otherwise let sandboxProfile fall back to the unresolved
  // path, producing an unconfined / mis-confined profile. Refuse to build the server.
  if (!existsSync(ctx.taskDir)) throw new Error(`workspace dir does not exist: ${ctx.taskDir}`);
  const shTool = tool(
    "sh",
    // The `ps` note is not trivia: /bin/ps is setuid root and macOS refuses to exec a setuid
    // binary inside a sandbox, so it fails with EPERM no matter what the profile allows. Tools
    // that shell out to it (tree-kill, and the process-tree killers behind `concurrently
    // --kill-others` / nodemon) break on that alone. Saying so here costs one line and saves an
    // agent a debugging spiral into what looks like a permission it could request.
    "Run a shell command inside the sandboxed workspace. Writes are confined to the workspace; " +
    "the user's secrets and other repos are unreadable. Use this instead of raw shell access. " +
    "Note: `ps` and other setuid tools (top, su) cannot run in the sandbox — use shell job " +
    "control ($!, jobs, kill %1) instead of process-table lookups. Killing your own processes " +
    "and their descendants works.",
    { cmd: z.string() },
    async (args) => text((await runJailed(ctx, args.cmd)).output),
  );
  return createSdkMcpServer({ name: "code", version: "0.1.0", tools: [shTool] });
}
