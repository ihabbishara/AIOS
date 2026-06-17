import type { Store } from "../store/db.js";
import type { AiosEvent } from "../events.js";

export interface Initiative {
  title: string;
  why: string;
  suggestion: string;
}

const DAY_MS = 86_400_000;
function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

interface Meeting { summary: string; start: string; end: string }

/** Next-window meetings parsed from the `gcal:<account>:snapshot` kv entries. */
function collectMeetings(store: Store, fromIso: string, toIso: string): Meeting[] {
  const out: Meeting[] = [];
  for (const row of safe(() => store.kvByPrefix("gcal:"), [] as Array<{ key: string; value: string }>)) {
    if (!/^gcal:.+:snapshot$/.test(row.key)) continue;
    let snap: Record<string, { summary: string; start: string; end?: string }>;
    try { snap = JSON.parse(row.value) as never; } catch { continue; }
    for (const e of Object.values(snap)) {
      if (e.start >= fromIso && e.start <= toIso) out.push({ summary: e.summary, start: e.start, end: e.end ?? e.start });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Same-day overlapping meetings → conflict lines. */
function findConflicts(meetings: Meeting[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < meetings.length; i++) {
    const prev = meetings[i - 1], cur = meetings[i];
    if (prev.start.slice(0, 10) === cur.start.slice(0, 10) && prev.end > cur.start) {
      out.push(`${prev.summary} overlaps ${cur.summary} on ${cur.start.slice(0, 10)}`);
    }
  }
  return out;
}

/**
 * Compile a non-sensitive observations digest for the dream cycle.
 * Sources: pending reminders (overdue + upcoming 7d), next-7d calendar (+ conflicts),
 * recurring rejections (last 7d), failed jobs (last 24h). NEVER reads money tables or email content.
 * Returns "" when nothing is worth observing.
 */
export function collectObservations(store: Store, now: Date): string {
  const nowIso = now.toISOString();
  const in7d = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  const sections: string[] = [];

  // Reminders
  const reminders = safe(() => store.listReminders("pending"), []);
  const overdue = reminders.filter((r) => r.due_at < nowIso);
  const upcoming = reminders.filter((r) => r.due_at >= nowIso && r.due_at <= in7d);
  if (overdue.length || upcoming.length) {
    const lines = [
      ...overdue.map((r) => `  OVERDUE #${r.id} ${r.text} (due ${r.due_at.slice(0, 10)})`),
      ...upcoming.map((r) => `  upcoming #${r.id} ${r.text} (due ${r.due_at.slice(0, 10)})`),
    ];
    sections.push(`REMINDERS:\n${lines.join("\n")}`);
  }

  // Calendar (next 7d)
  const meetings = collectMeetings(store, nowIso, in7d);
  if (meetings.length) {
    const lines = meetings.map((m) => `  ${m.start.slice(0, 16).replace("T", " ")} ${m.summary}`);
    const conflicts = findConflicts(meetings).map((c) => `  CONFLICT: ${c}`);
    sections.push(`CALENDAR (next 7d):\n${[...lines, ...conflicts].join("\n")}`);
  }

  // Decisions — recurring rejections in the last 7d
  const sevenAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const rejByType = new Map<string, number>();
  for (const d of safe(() => store.listDecisions(sevenAgo), [])) {
    if (d.verdict === "rejected") rejByType.set(d.type, (rejByType.get(d.type) ?? 0) + 1);
  }
  const recurring = [...rejByType.entries()].filter(([, n]) => n >= 2);
  if (recurring.length) {
    sections.push(`DECISIONS:\n${recurring.map(([t, n]) => `  rejected ${n}×: ${t}`).join("\n")}`);
  }

  // Jobs — failed in the last 24h
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const failed: string[] = [];
  for (const row of safe(() => store.listEventsSince(dayAgo), [] as Array<{ id: number; ts: string; payload: string }>)) {
    let e: AiosEvent;
    try { e = JSON.parse(row.payload) as AiosEvent; } catch { continue; }
    if (e.type === "job.status" && e.status === "failed") {
      failed.push(`  failed: ${store.getJob(e.jobId)?.title ?? e.jobId} — ${e.error ?? "unknown"}`);
    }
  }
  if (failed.length) sections.push(`JOBS:\n${failed.join("\n")}`);

  return sections.join("\n\n");
}
