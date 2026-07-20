import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
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
  /** Resolved tool-surface hash — when provided, a stored-hash mismatch (or absence)
   *  starts a fresh session instead of resuming a stale surface. */
  surfaceHash?: string;
}

export const LOCKDOWN_RE = /No conversation found|dangerouslyDisableSandbox/i;

/** Hash of the resolved surface — tools + static persona scope (specs 2026-07-19 + 2026-07-20):
 *  a resumed session whose tool surface OR static persona changed must NOT resume. The dynamic
 *  memo/moderator blocks stay excluded — nightly re-renders never invalidate (hermes continuity). */
export function surfaceHash(options: Options, personaSurface?: string): string {
  const payload = JSON.stringify({
    tools: [...(options.allowedTools ?? [])].sort(),
    servers: Object.keys(options.mcpServers ?? {}).sort(),
    mode: options.permissionMode ?? null,
    persona: personaSurface ?? null,
    skills: [...(options.skills ?? [])].sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

const surfaceKey = (sessionKey: string) => `surface:${sessionKey}`;

/** Stored resume id, or undefined when it must not be used. With a hash param, an absent
 *  stored hash is a mismatch (fail-closed): pre-feature sessions reset once at first turn. */
export function resumeFor(store: Store, sessionKey: string, hash?: string): string | undefined {
  const id = store.kvGet(sessionKey);
  if (!id) return undefined;
  if (hash !== undefined && store.kvGet(surfaceKey(sessionKey)) !== hash) return undefined;
  return id;
}

/**
 * Runs one turn of a persistent conversation: resumes the stored session if any,
 * persists the session id only on success, and heals automatically when the
 * stored id no longer exists on disk (retries once with a fresh session).
 */
export async function resumableTurn(params: ResumableTurnParams): Promise<string> {
  const stored = params.store.kvGet(params.sessionKey);
  const resume = resumeFor(params.store, params.sessionKey, params.surfaceHash);
  if (stored && !resume && params.surfaceHash !== undefined) {
    params.log?.(`tool surface changed for ${params.sessionKey} — starting fresh session`);
  }
  try {
    return await runOnce(params, resume);
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
          if (params.surfaceHash !== undefined) {
            params.store.kvSet(surfaceKey(params.sessionKey), params.surfaceHash);
          }
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
