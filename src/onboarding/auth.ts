// src/onboarding/auth.ts — token verification via one minimal SDK call (onboarding spec §2).
// The ping is injectable so tests never touch the network; sdkPing is the production default.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Ping = (token: string) => Promise<void>;

/** Every other way the spawned CLI could authenticate as somebody other than the pasted token. */
const RIVAL_CREDENTIALS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
];

/**
 * The environment for the spawned CLI, with the pasted token as its only way in. CLAUDE_CONFIG_DIR
 * gets an empty dir because the CLI otherwise falls back to the machine's stored login and answers
 * "pong" for a garbage token — which is the whole thing this check exists to catch.
 */
export function pingEnv(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "aios-verify-")),
  };
  for (const key of RIVAL_CREDENTIALS) delete env[key];
  return env;
}

/**
 * Runs `fn` against a fresh ping environment and removes its throwaway CLAUDE_CONFIG_DIR after,
 * however `fn` ends. The dir is per-call by design, so without this every verification — and a
 * user retypes a bad token more than once — leaves another aios-verify-* behind in tmpdir.
 */
export async function withPingEnv<T>(
  token: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const env = pingEnv(token);
  try {
    return await fn(env);
  } finally {
    rmSync(env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
  }
}

/** A rejected token still arrives as subtype "success" — only is_error tells the truth. */
export function pingFailure(
  msg: { subtype: string; is_error?: boolean; api_error_status?: number | null; result?: string },
): string | null {
  if (msg.subtype !== "success") return `auth check failed: ${msg.subtype}`;
  if (!msg.is_error && (msg.api_error_status ?? null) === null) return null;
  return msg.result?.trim() || "auth check failed: the API rejected the token";
}

/** One-shot, no tools, no session — the cheapest call that proves this token works. */
export const sdkPing: Ping = (token) => withPingEnv(token, async (env) => {
  const q = query({
    prompt: "ping",
    options: { allowedTools: [], maxTurns: 1, settingSources: [], persistSession: false, env },
  });
  // Leaving the loop closes the query, which stops the CLI — so the config dir outlives the
  // subprocess that reads it, and withPingEnv only deletes it once we are past this point.
  for await (const msg of q) {
    if (msg.type === "result") {
      const failure = pingFailure(msg);
      if (failure) throw new Error(failure);
      return;
    }
  }
  throw new Error("auth check failed: no result from SDK");
});

export async function verifyToken(
  token: string, ping: Ping = sdkPing,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = token.trim();
  if (!t) return { ok: false, error: "token required" };
  // A line break survives into updateEnvFile's `KEY=value` line and would append arbitrary .env lines.
  if (/[\r\n]/.test(t)) return { ok: false, error: "token must be a single line" };
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = t;
  // An API key would authenticate the ping on its own and vouch for a bad token, so hide it —
  // and always put it back, unlike the token: bootMode counts it as auth.
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await ping(t);
    return { ok: true };
  } catch (err) {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    return { ok: false, error: (err as Error).message };
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
}
