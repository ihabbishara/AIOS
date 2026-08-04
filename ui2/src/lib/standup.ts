// ui2/src/lib/standup.ts — the standup ritual, read out of the mail table
// (spec 2026-08-03-mail-pulse-design §1–§3).
//
// 45 of 72 mail rows are a daily standup. 40 carry all three of Done / Today /
// Blockers, 5 are `API Error` rows where the check-in never happened. The
// parser is deliberately TOLERANT: agents emit the fields bolded (`**Done:**`),
// inline on one line, and behind narration ("Here is the standup:"). A strict
// newline-anchored matcher scored 14 of 45 as malformed and was simply wrong.
//
// Nothing here throws on a body it does not understand — an unrecognised body
// falls back to `raw` and is rendered verbatim, never dropped and never coerced
// into empty fields.
import type { MailView } from "../api.js";

export interface StandupFields { done: string; today: string; blockers: string }

export type ParsedStandup =
  | { kind: "checkin"; fields: StandupFields }
  | { kind: "failed"; reason: string }
  | { kind: "raw"; body: string };

/** Field labels, tolerating `**bold**` and the singular "Blocker". */
const LABEL = /\*{0,2}\b(done|today|blockers?)\b\*{0,2}\s*:/gi;

/** Strip markdown emphasis, horizontal rules and stray bullets off a field value. */
function clean(s: string): string {
  return s.replace(/\*+/g, "").replace(/^[\s\-–—]+|[\s\-–—]+$/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function parseStandup(body: string): ParsedStandup {
  const text = body.trim();

  // A failed check-in is not a check-in with empty fields. It is its own state.
  if (/^\*{0,2}api error/i.test(text)) {
    return { kind: "failed", reason: text.replace(/^\*{0,2}api error\*{0,2}\s*:?\s*/i, "").trim() || text };
  }

  // First occurrence of each label wins: the template orders Done → Today →
  // Blockers, and a later "today:" inside prose must not re-split the field.
  const hits: Array<{ label: keyof StandupFields; start: number; end: number }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(LABEL)) {
    const word = m[1].toLowerCase();
    const label = (word.startsWith("blocker") ? "blockers" : word) as keyof StandupFields;
    if (seen.has(label) || m.index === undefined) continue;
    seen.add(label);
    hits.push({ label, start: m.index, end: m.index + m[0].length });
  }
  if (hits.length < 3) return { kind: "raw", body: text };

  hits.sort((a, b) => a.start - b.start);
  const fields = { done: "", today: "", blockers: "" };
  hits.forEach((h, i) => {
    const stop = i + 1 < hits.length ? hits[i + 1].start : text.length;
    fields[h.label] = clean(text.slice(h.end, stop));
  });
  // Anything before the first label is narration the agent added, and is dropped.
  return { kind: "checkin", fields };
}

export interface DayEntry { agent: string; at: string; parsed: ParsedStandup }
export type DayState = "checked" | "failed" | "silent";
export interface DayCell { date: string; entries: DayEntry[]; state: DayState }

/** The ritual is scheduled at 04:00–05:00 UTC, and the store groups it by UTC
 *  date. Slicing the ISO stamp keeps the client agreeing with the database
 *  rather than re-bucketing a morning into the viewer's timezone. */
export const dayKey = (iso: string): string => iso.slice(0, 10);

export function stateOf(entries: DayEntry[]): DayState {
  if (entries.length === 0) return "silent";
  return entries.some((e) => e.parsed.kind === "failed") ? "failed" : "checked";
}

/** A contiguous window ending today — silent days are PRESENT as empty cells.
 *  Omitting them would hide the thing the strip exists to show. */
export function groupByDay(mail: MailView[], now: Date, days = 30): DayCell[] {
  const byDate = new Map<string, DayEntry[]>();
  for (const m of mail) {
    if (m.kind !== "standup") continue;
    const key = dayKey(m.createdAt);
    const entry: DayEntry = { agent: m.from, at: m.createdAt, parsed: parseStandup(m.body) };
    const list = byDate.get(key);
    if (list) list.push(entry); else byDate.set(key, [entry]);
  }

  const cells: DayCell[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(cursor.getTime() - i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    const entries = (byDate.get(date) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    cells.push({ date, entries, state: stateOf(entries) });
  }
  return cells;
}

export interface Exchange {
  key: string;
  goalId: string | null;
  request: MailView | null;
  reports: MailView[];
  at: string;
}

/** Work traffic, whose real unit is the round trip, not the message: all 26
 *  request/report rows carry a goal_id, and every goal_id resolves to one
 *  request and its report(s) between exactly two agents. Mail with no goal
 *  (the single `note` row) stands alone rather than being dropped. */
export function exchangesOf(mail: MailView[]): Exchange[] {
  const groups = new Map<string, MailView[]>();
  for (const m of mail) {
    if (m.kind === "standup") continue;
    const key = m.goalId ?? m.id;
    const list = groups.get(key);
    if (list) list.push(m); else groups.set(key, [m]);
  }
  return [...groups.entries()]
    .map(([key, msgs]) => {
      const sorted = [...msgs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const request = sorted.find((m) => m.kind === "request") ?? null;
      return {
        key,
        goalId: sorted[0].goalId,
        request,
        reports: sorted.filter((m) => m !== request),
        at: sorted[sorted.length - 1].createdAt,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
