import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store/db.js";

export interface ResumableTurnParams {
  store: Store;
  /** kv key holding the SDK session id for this conversation. */
  sessionKey: string;
  prompt: string;
  options: Options;
  log?: (line: string) => void;
}

export const LOCKDOWN_RE = /No conversation found|dangerouslyDisableSandbox/i;

/**
 * Runs one turn of a persistent conversation: resumes the stored session if any,
 * persists the session id only on success, and heals automatically when the
 * stored id no longer exists on disk (retries once with a fresh session).
 */
export async function resumableTurn(params: ResumableTurnParams): Promise<string> {
  const existing = params.store.kvGet(params.sessionKey);
  try {
    return await runOnce(params, existing || undefined);
  } catch (err) {
    if (err instanceof Error && LOCKDOWN_RE.test(err.message)) {
      params.log?.(`stale/locked session for ${params.sessionKey}, starting fresh`);
      params.store.kvSet(params.sessionKey, "");
      return await runOnce(params, undefined);
    }
    throw err;
  }
}

/**
 * Clears a stored session id so the next turn begins a fresh SDK session.
 * Intended for future callers: admin API, CLI commands, scheduled cleanup jobs.
 */
export function clearSession(store: Store, sessionKey: string): void {
  store.kvSet(sessionKey, "");
}

async function runOnce(params: ResumableTurnParams, resume: string | undefined): Promise<string> {
  const q = query({
    prompt: params.prompt,
    options: { ...params.options, ...(resume ? { resume } : {}) },
  });

  let reply = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        // Only persist ids from successful turns — errored turns may never be
        // written to disk and would poison future resumes.
        params.store.kvSet(params.sessionKey, msg.session_id);
        reply = msg.result;
      } else {
        const detail = "errors" in msg ? msg.errors.join("; ") : "";
        params.log?.(`turn error (${params.sessionKey}): ${msg.subtype}${detail ? ` — ${detail}` : ""}`);
        reply = `Something went wrong handling that (${msg.subtype}${detail ? `: ${detail}` : ""}). Try again.`;
      }
    }
  }
  return reply || "(no reply)";
}
