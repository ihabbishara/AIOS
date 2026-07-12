// src/code/exec.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
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
    "(allow signal (target self))",
    // Egress: analyze (read-only audit) needs no network → deny-default covers it.
    // Build keeps network for package installs unless AIOS_SANDBOX_NET=deny.
    (opts?.net ?? (mode === "build" ? "allow" : "deny")) === "allow" ? "(allow network*)" : "",
    "(allow file-read*)",
    // secrets win (last-match): never readable inside the sandbox. Deny lines
    // live in the unified secrets module (src/kernel/secrets.ts) — superset of
    // isSecretPath's families plus credential stores a shell could `cat` by
    // absolute path. Scoped to path families, so toolchain reads stay allowed.
    ...sbplSecretDenyLines(),
    writeAllow,
  ].filter(Boolean).join("\n");
}

export function buildCodeServer(ctx: { taskDir: string; mode: "build" | "analyze"; timeoutMs?: number }) {
  // Fail-closed: a missing dir would otherwise let sandboxProfile fall back to the unresolved
  // path, producing an unconfined / mis-confined profile. Refuse to build the server.
  if (!existsSync(ctx.taskDir)) throw new Error(`workspace dir does not exist: ${ctx.taskDir}`);
  const shTool = tool(
    "sh",
    "Run a shell command inside the sandboxed workspace. Writes are confined to the workspace; the user's secrets and other repos are unreadable. Use this instead of raw shell access.",
    { cmd: z.string() },
    async (args) =>
      new Promise((resolve) => {
        const profile = sandboxProfile(
          ctx.taskDir, ctx.mode,
          process.env.AIOS_SANDBOX_NET === "deny" ? { net: "deny" } : undefined,
        );
        // Temp dir lives INSIDE the jail so toolchains have scratch space without a
        // world-writable /tmp allow. It's under taskDir, so the subpath write rule covers it.
        const jailTmp = join(ctx.taskDir, ".aios-tmp");
        mkdirSync(jailTmp, { recursive: true });
        execFile(
          "sandbox-exec",
          ["-p", profile, "/bin/bash", "-lc", args.cmd],
          {
            cwd: ctx.taskDir,
            timeout: ctx.timeoutMs ?? 120_000,
            maxBuffer: 8 * 1024 * 1024,
            // Curated allowlist env — the daemon's secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) never
            // reach the jailed shell, so a build can't read them from the environment and exfil.
            env: jailEnv(ctx.taskDir),
          },
          (err, stdout, stderr) => {
            const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
            resolve(text(err ? `Command failed (${err.message}).\n${out}` : out || "(no output)"));
          },
        );
      }),
  );
  return createSdkMcpServer({ name: "code", version: "0.1.0", tools: [shTool] });
}
