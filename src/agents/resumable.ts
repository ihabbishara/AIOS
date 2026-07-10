import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store/db.js";

export interface ResumableTurnParams {
  store: Store;
  /** kv key holding the SDK session id for this conversation. */
  sessionKey: string;
  prompt: string;
  options: Options;
  log?: (line: string) => void;
  /** Fired once, only on a successful turn (same point the session id is persisted) — used to
   *  commit unread-mail delivery so a crashed/errored turn re-surfaces the mail. */
  onSuccess?: () => void;
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

const epochKey = (sessionKey: string) => `reset-epoch:${sessionKey}`;

/**
 * Clears a stored session id AND bumps the reset epoch, so a turn already in
 * flight cannot write its (now stale) session id back when it completes.
 */
export function clearSession(store: Store, sessionKey: string): void {
  store.kvSet(sessionKey, "");
  store.kvSet(epochKey(sessionKey), String(Number(store.kvGet(epochKey(sessionKey)) || 0) + 1));
}

async function runOnce(params: ResumableTurnParams, resume: string | undefined): Promise<string> {
  const epochAtStart = params.store.kvGet(epochKey(params.sessionKey));
  const q = query({
    prompt: params.prompt,
    options: { ...params.options, ...(resume ? { resume } : {}) },
  });

  let reply = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype === "success") {
        // Only persist ids from successful turns — errored turns may never be
        // written to disk and would poison future resumes. And only when no
        // /reset landed mid-flight (reset-epoch unchanged) — otherwise the
        // completing turn would silently undo the reset.
        if (params.store.kvGet(epochKey(params.sessionKey)) === epochAtStart) {
          params.store.kvSet(params.sessionKey, msg.session_id);
        } else {
          params.log?.(`reset during in-flight turn for ${params.sessionKey} — session id not persisted`);
        }
        params.onSuccess?.(); // commit mail delivery at the same success gate
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
