// src/code/exec.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { z } from "zod";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** macOS sandbox profile (SBPL). Deny-default; broad read minus the secret denylist;
 *  write only under the task dir (build) + tmp. Later rules override earlier for the
 *  same operation, so the secret denies must come AFTER the broad read allow. */
export function sandboxProfile(taskDir: string, mode: "build" | "analyze"): string {
  // Resolve symlinks so macOS /var/folders -> /private/var/folders works in SBPL subpath matching.
  let realDir = taskDir;
  try { realDir = realpathSync(taskDir); } catch { /* non-existent dirs are used in unit tests */ }
  const writeAllow = mode === "build"
    ? `(allow file-write* (subpath "${realDir}") (subpath "/private/tmp") (subpath "/tmp"))`
    : "";
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    "(allow network*)", // egress restriction is a Docker-tier follow-up
    "(allow file-read*)",
    // secrets win (last-match): never readable inside the sandbox
    '(deny file-read* (regex #"/\\.ssh/") (regex #"/\\.aws/") (regex #"/\\.gnupg/"))',
    '(deny file-read* (regex #"/projects/AIOS/") (regex #"\\.env($|\\.)") (regex #"(token|credential|secret)"))',
    writeAllow,
  ].filter(Boolean).join("\n");
}

export function buildCodeServer(ctx: { taskDir: string; mode: "build" | "analyze"; timeoutMs?: number }) {
  const shTool = tool(
    "sh",
    "Run a shell command inside the sandboxed workspace. Writes are confined to the workspace; the user's secrets and other repos are unreadable. Use this instead of raw shell access.",
    { cmd: z.string() },
    async (args) =>
      new Promise((resolve) => {
        const profile = sandboxProfile(ctx.taskDir, ctx.mode);
        execFile(
          "sandbox-exec",
          ["-p", profile, "/bin/bash", "-lc", args.cmd],
          { cwd: ctx.taskDir, timeout: ctx.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
            resolve(text(err ? `Command failed (${err.message}).\n${out}` : out || "(no output)"));
          },
        );
      }),
  );
  return createSdkMcpServer({ name: "code", version: "0.1.0", tools: [shTool] });
}
