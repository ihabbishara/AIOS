import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import { DOMAINS, type Domain } from "./recall.js";

const CAP = 3000;
/** Memos always loaded into the moderator prompt (the rest load on demand via recall). */
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

/** Compact preferences/profile block injected into the moderator system prompt each turn. */
export function memoContext(store: Store, vault: VaultWriter): string {
  const parts: string[] = [];
  const profile = vault.readNote("memos/profile.md");
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
