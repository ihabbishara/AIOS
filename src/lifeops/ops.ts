import type { PersonalTaskRow } from "../store/db.js";

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface OpenLoops {
  overdue: Array<{ title: string; due_date: string }>;
  dueToday: string[];
  openCount: number;
}

export interface LifeopsSignal { key: string; text: string }
export interface LifeopsSignalConfig { lifeopsSoonDays: number; lifeopsStaleDays: number }

/** Partition already-fetched open tasks for the morning brief. `today` is YYYY-MM-DD. */
export function openLoopsForBrief(openTasks: PersonalTaskRow[], today: string): OpenLoops {
  const overdue = openTasks
    .filter((t) => t.due_date && t.due_date < today)
    .map((t) => ({ title: t.title, due_date: t.due_date! }));
  const dueToday = openTasks.filter((t) => t.due_date === today).map((t) => t.title);
  return { overdue, dueToday, openCount: openTasks.length };
}

/**
 * Proactive nudges over already-fetched open tasks. Each signal's `key` embeds a date so a task
 * fires once per transition (per-day for overdue/stale, per-due-date for soon). The caller checks
 * each key against kv, sends `text` to the private chat, then stamps the key.
 */
export function computeLifeopsSignals(
  openTasks: PersonalTaskRow[], now: Date, cfg: LifeopsSignalConfig,
): LifeopsSignal[] {
  const today = iso(now);
  const soonMax = iso(new Date(now.getTime() + cfg.lifeopsSoonDays * DAY));
  const out: LifeopsSignal[] = [];
  for (const t of openTasks) {
    if (t.due_date && t.due_date < today) {
      out.push({
        key: `lifeops:overdue:${t.id}:${today}`,
        text: `Overdue: "${t.title}"${t.next_action ? ` — next: ${t.next_action}` : ""} (was due ${t.due_date}).`,
      });
    } else if (t.due_date && t.due_date >= today && t.due_date <= soonMax) {
      out.push({ key: `lifeops:soon:${t.id}:${t.due_date}`, text: `Due ${t.due_date}: "${t.title}".` });
    } else if (!t.due_date && Date.parse(t.updated_at) < now.getTime() - cfg.lifeopsStaleDays * DAY) {
      out.push({
        key: `lifeops:stale:${t.id}:${today}`,
        text: `Stale open loop (${cfg.lifeopsStaleDays}d untouched): "${t.title}".`,
      });
    }
  }
  return out;
}
