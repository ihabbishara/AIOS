// src/memory/facts.ts — fact-granular memos (memory-v2 spec §4). Facts are the truth;
// the vault memo markdown is a RENDERED PROJECTION of the active set. Same vault path,
// same prompt-injection seams, same 3k cap (memoContext truncates downstream).
import type { Store, MemoFactRow } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import { tokenize } from "./tokenize.js";
import { memoRelPath } from "./memos.js";
import type { Domain } from "./recall.js";

/** Render the active facts of one domain as the memo markdown. Untrusted-origin facts are
 *  NEVER rendered — every memo reaches a prompt.system sink (moderator or pack agents), so the
 *  spec §4 rule is applied universally at render time. Empty active set → "" (caller keeps prior). */
export function renderMemo(domain: string, facts: MemoFactRow[]): string {
  const usable = facts.filter((f) => f.domain === domain && f.status === "active" && f.origin !== "untrusted");
  if (!usable.length) return "";
  const bySubject = new Map<string, MemoFactRow[]>();
  for (const f of usable) {
    const list = bySubject.get(f.subject) ?? [];
    list.push(f);
    bySubject.set(f.subject, list);
  }
  const parts: string[] = [`# ${domain} memo`];
  for (const [subject, list] of [...bySubject.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(`\n## ${subject}`);
    for (const f of list) parts.push(`- ${f.fact} (${f.ts.slice(0, 10)})`);
  }
  return parts.join("\n");
}

const FORGET_ORIGIN = { channel: "system", chatId: "forget" };

/** Immediate user-correction supersede (spec §4): match active facts by token overlap and
 *  supersede NOW, then refresh the affected domain memos on the spot (through the gate —
 *  vault.write is seeded autonomous, so the render lands immediately). Returns superseded count. */
export async function forgetNow(
  deps: { store: Store; vault: VaultWriter; gate: ActionGate; log?: (l: string) => void },
  text: string, domain?: string,
): Promise<number> {
  const qt = new Set(tokenize(text));
  if (!qt.size) return 0;
  const threshold = Math.max(1, Math.ceil(qt.size * 0.6));
  const candidates = deps.store.activeMemoFacts(domain);
  const hit = candidates.filter((f) => {
    const ft = new Set(tokenize(`${f.subject} ${f.fact}`));
    let overlap = 0;
    for (const t of qt) if (ft.has(t)) overlap++;
    return overlap >= threshold;
  });
  if (!hit.length) return 0;
  // Mirror the distiller's discipline: render PROSPECTIVELY (memo without the hit facts) and
  // supersede in the DB only when the gate write EXECUTES. Superseding first would drop the fact
  // from memo_facts while the still-unwritten memo file keeps feeding it into the system prompt —
  // the "forgotten" content would keep reaching the prompt if the write were ever queued.
  const hitIds = new Set(hit.map((f) => f.id));
  const domains = new Set(hit.map((f) => f.domain));
  let forgotten = 0;
  for (const d of domains) {
    const remaining = deps.store.activeMemoFacts(d).filter((f) => !hitIds.has(f.id));
    const md = renderMemo(d, remaining);
    const content = md || `# ${d} memo\n\n(empty)`;
    const row = await deps.gate.propose(
      { type: "vault.write", payload: { path: memoRelPath(d as Domain), content }, preview: `Forget: refresh ${d} memo` },
      FORGET_ORIGIN,
    );
    if (row.status === "executed") {
      for (const f of hit) if (f.domain === d) { deps.store.supersedeMemoFact(f.id, null); forgotten++; }
    } else {
      deps.log?.(`forgetNow: ${d} memo refresh not executed (${row.status}) — facts kept`);
    }
  }
  return forgotten;
}
