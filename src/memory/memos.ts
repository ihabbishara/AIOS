import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import { DOMAINS, type Domain } from "./recall.js";

/** Character cap (≈ 750–1000 tokens) — kept small to stay within the moderator context budget. */
const CAP = 3000;
/** Memos always loaded into the moderator prompt (the rest load on demand via recall). */
// "inbox" is distilled calendar signal (calendar.changed) — attacker-influenceable invite text
// can reach the system prompt via inbox.md. Defense-in-depth: the Action Gate still protects all
// effects, and the curator must not copy invite text verbatim. The teaching path is separately
// guarded (Task 6 remember/forget anti-injection note).
const ALWAYS_LOADED: Domain[] = ["general", "inbox"];

export function memoRelPath(domain: Domain): string {
  return `memos/${domain}.md`;
}

export const CURATOR_SYSTEM =
  "You are the AI-OS memory curator. You maintain concise, durable markdown memos capturing the " +
  "user's preferences and stable facts. Merge new signals into the existing memo: dedup, keep it tight, " +
  "attach brief evidence (counts/dates) where useful, remove anything a 'forget' signal asks to drop, and " +
  "on contradictions keep the newer fact noting the old in parentheses. " +
  "Output ONLY the updated memo markdown — no preamble, no code fences, no commentary.";

export function buildCuratePrompt(domain: string, existing: string, signals: string): string {
  return [
    `Domain: ${domain}`,
    "",
    "## Current memo (may be empty)",
    existing.trim() || "(empty)",
    "",
    "## New signals since last update",
    signals.trim() || "(none)",
    "",
    "Produce the UPDATED memo. Output ONLY the memo markdown.",
  ].join("\n");
}

/** Compact preferences/profile block injected into the moderator system prompt each turn.
 *  Reads files fresh every turn so edits to vault memos take effect immediately (no restart). */
export function memoContext(store: Store, vault: VaultWriter): string {
  const parts: string[] = [];
  const profile = vault.readNote(memoRelPath("profile"));
  if (profile?.trim()) parts.push(profile.trim());
  for (const d of ALWAYS_LOADED) {
    const m = vault.readNote(memoRelPath(d));
    if (m?.trim()) parts.push(m.trim());
  }
  const pending = store.listUnconsolidatedTeachings();
  if (pending.length) {
    parts.push("## Pending (not yet distilled)\n" + pending.map((t) => `- ${t.text}`).join("\n"));
  }
  if (!parts.length) return "";
  let block = "## Learned preferences & profile\n\n" + parts.join("\n\n");
  if (block.length > CAP) block = block.slice(0, CAP) + "\n…(more in memos/)";
  return block;
}

export { DOMAINS };
