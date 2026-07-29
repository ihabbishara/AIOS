// src/onboarding/auth.ts — token verification via one minimal SDK call (onboarding spec §2).
// The ping is injectable so tests never touch the network; sdkPing is the production default.
import { query } from "@anthropic-ai/claude-agent-sdk";

export type Ping = () => Promise<void>;

/** One-shot, no tools, no session — the cheapest call that proves the token works. */
export const sdkPing: Ping = async () => {
  const q = query({
    prompt: "ping",
    options: { allowedTools: [], maxTurns: 1, settingSources: [], persistSession: false },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") return;
      throw new Error(`auth check failed: ${msg.subtype}`);
    }
  }
  throw new Error("auth check failed: no result from SDK");
};

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
    await ping();
    return { ok: true };
  } catch (err) {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    return { ok: false, error: (err as Error).message };
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
}
