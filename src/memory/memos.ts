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
/** Domains whose memos are injected into the moderator SYSTEM prompt — the prompt.system sink
 *  the distiller must keep untrusted-origin content out of (spec §6, inbox.md vector). */
export const ALWAYS_LOADED: Domain[] = ["general", "inbox"];

export function memoRelPath(domain: Domain): string {
  return `memos/${domain}.md`;
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

/** Pillar-scoped variant of memoContext: profile + one domain's memo + that domain's pending
 *  teachings. Used by pack agents (not the moderator's general/inbox set). */
export function memoContextForDomain(store: Store, vault: VaultWriter, domain: string): string {
  const parts: string[] = [];
  const profile = vault.readNote(memoRelPath("profile"));
  if (profile?.trim()) parts.push(profile.trim());
  const memo = vault.readNote(memoRelPath(domain as Domain));
  if (memo?.trim()) parts.push(memo.trim());
  const pending = store.listUnconsolidatedTeachings(domain);
  if (pending.length) {
    parts.push("## Pending (not yet distilled)\n" + pending.map((t) => `- ${t.text}`).join("\n"));
  }
  if (!parts.length) return "";
  let block = "## Learned preferences & profile\n\n" + parts.join("\n\n");
  if (block.length > CAP) block = block.slice(0, CAP) + "\n…(more in memos/)";
  return block;
}

export { DOMAINS };
