// src/heartbeat/routines.ts — recurrence primitives + fire handler for routines
// (spec docs/superpowers/specs/2026-07-15-scheduling-routines-design.md).
// IMPORTANT: this file is pulled into ui2's type graph via web/dto.ts — it may
// import ONLY pure-type modules (channels/types), never db.ts or clock.ts.
import type { InboundMessage } from "../channels/types.js";

export type Recurrence =
  | { kind: "daily"; hhmm: string }
  | { kind: "weekdays"; hhmm: string }
  | { kind: "weekly"; dow: number; hhmm: string }
  | { kind: "interval"; everyMinutes: number };

/** Structural subset of RoutineRow — keeps this module free of db.ts imports. */
export interface RoutineLike {
  enabled: number;
  recurrence: string;
  last_fired_at: string | null;
  last_fired_date: string | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// Private duplicate of clock.ts localParts — importing clock here would cycle.
function parts(d: Date): { date: string; hhmm: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** Validates an untrusted recurrence value (API boundary / stored JSON). Null on any malformed shape. */
export function parseRecurrence(raw: unknown): Recurrence | null {
  const r = typeof raw === "string" ? safeJson(raw) : raw;
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  switch (o.kind) {
    case "daily":
    case "weekdays":
      return typeof o.hhmm === "string" && HHMM.test(o.hhmm) ? { kind: o.kind, hhmm: o.hhmm } : null;
    case "weekly":
      return typeof o.hhmm === "string" && HHMM.test(o.hhmm) &&
        typeof o.dow === "number" && Number.isInteger(o.dow) && o.dow >= 0 && o.dow <= 6
        ? { kind: "weekly", dow: o.dow, hhmm: o.hhmm }
        : null;
    case "interval":
      // Ceiling (1 year) so an absurd value can't produce a routine that silently never fires.
      return typeof o.everyMinutes === "number" && Number.isInteger(o.everyMinutes) &&
        o.everyMinutes >= 1 && o.everyMinutes <= 525_600
        ? { kind: "interval", everyMinutes: o.everyMinutes }
        : null;
    default:
      return null;
  }
}

/**
 * Due-test, pure. Time-of-day kinds use same-day-only semantics (time passed +
 * not fired today → same-day catch-up fires once, not N times) — unlike anchors,
 * routines do NOT catch up across midnight; interval fires when the gap since
 * last_fired_at has elapsed.
 */
export function routineDue(now: Date, r: RoutineLike): boolean {
  if (!r.enabled) return false;
  const rec = parseRecurrence(r.recurrence);
  if (!rec) return false;
  const p = parts(now);
  switch (rec.kind) {
    case "daily":
      return p.hhmm >= rec.hhmm && r.last_fired_date !== p.date;
    case "weekdays":
      return now.getDay() >= 1 && now.getDay() <= 5 && p.hhmm >= rec.hhmm && r.last_fired_date !== p.date;
    case "weekly":
      return now.getDay() === rec.dow && p.hhmm >= rec.hhmm && r.last_fired_date !== p.date;
    case "interval":
      return r.last_fired_at === null ||
        now.getTime() - new Date(r.last_fired_at).getTime() >= rec.everyMinutes * 60_000;
  }
}

/** Next scheduled fire as local "YYYY-MM-DD HH:MM" — display-only, null when unparseable. */
export function nextFire(now: Date, r: RoutineLike): string | null {
  const rec = parseRecurrence(r.recurrence);
  if (!rec) return null;
  if (rec.kind === "interval") {
    const base = r.last_fired_at
      ? new Date(r.last_fired_at).getTime() + rec.everyMinutes * 60_000
      : now.getTime();
    const p = parts(new Date(Math.max(base, now.getTime())));
    return `${p.date} ${p.hhmm}`;
  }
  const matches = (d: Date): boolean =>
    rec.kind === "daily" ? true
    : rec.kind === "weekdays" ? d.getDay() >= 1 && d.getDay() <= 5
    : d.getDay() === rec.dow;
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const p = parts(d);
    if (!matches(d)) continue;
    if (r.last_fired_date === p.date) continue;
    if (i === 0 && parts(now).hhmm >= rec.hhmm) continue;
    return `${p.date} ${rec.hhmm}`;
  }
  return null;
}

export interface RoutineFireDeps {
  onMessage: (msg: InboundMessage) => Promise<void>;
  primaryChat?: { channel: string; chatId: string };
  /** Can a reply actually be PUSHED to this channel? Defaults to yes for every channel.
   *  Wired to the live channel map, so it also answers "is that channel connected right now". */
  canDeliver?: (channel: string) => boolean;
  log: (line: string) => void;
}

/** Where a fired routine/reminder should run so its answer reaches the user.
 *
 *  The origin chat, unless nothing can be pushed to it — a routine created in Mission Control
 *  carries origin `web:ui`, and `web` is a pull surface with no adapter, so `channels.get("web")`
 *  was undefined and every reply was dropped on the floor by an optional-chained send. The OCA
 *  sweep fired on time for four days and the user saw none of it. An origin that cannot receive
 *  the answer is not an origin worth honouring; the primary chat gets it instead. */
export function deliveryChat(
  ev: { channel: string; chatId: string }, deps: RoutineFireDeps,
): { channel: string; chatId: string; redirected: boolean } | null {
  const deliverable = (c: string): boolean => Boolean(c) && (deps.canDeliver?.(c) ?? true);
  if (deliverable(ev.channel) && ev.chatId) {
    return { channel: ev.channel, chatId: ev.chatId, redirected: false };
  }
  const p = deps.primaryChat;
  if (!p || !deliverable(p.channel) || !p.chatId) return null;
  return { channel: p.channel, chatId: p.chatId, redirected: Boolean(ev.channel) };
}

/**
 * The routine.due subscriber body: injects the prompt into the kernel as a
 * synthetic inbound message — the exact entry point chat messages use, so
 * routing, playbooks, trust gates, and reply delivery apply unchanged.
 * Origin falls back to the primary chat; with neither, the fire is dropped
 * with a log line (fire-and-forget, same posture as reminders).
 */
export function makeRoutineFire(deps: RoutineFireDeps) {
  return (ev: { id: number; name: string; prompt: string; channel: string; chatId: string }): void => {
    const to = deliveryChat(ev, deps);
    if (!to) {
      deps.log(`routine ${ev.id} (${ev.name}) skipped: no deliverable origin chat and no primary chat`);
      return;
    }
    const { channel, chatId, redirected } = to;
    if (redirected) {
      deps.log(`routine ${ev.id} (${ev.name}) redirected: ${ev.channel} cannot receive a reply → ${channel}:${chatId}`);
    }
    void deps.onMessage({ channel, chatId, text: ev.prompt })
      .catch((err) => deps.log(`routine ${ev.id} (${ev.name}) failed: ${(err as Error).message}`));
  };
}

/** The frame wrapped around a fired reminder's text. Neo decides per-reminder:
 *  a task gets carried out, a plain nudge gets relayed. */
export function reminderPrompt(text: string): string {
  return `[Scheduled reminder you set earlier] ${text}\n\n` +
    "If this is a task to carry out, do it now and report the result. " +
    "If it is just a nudge, relay it to me in one short line.";
}

/**
 * The reminder.due subscriber body (spec 2026-07-25). Mirrors makeRoutineFire:
 * a fired reminder is injected into the kernel as a synthetic inbound message
 * instead of being sent as a dead "⏰ Reminder:" ping, so the coordinator can
 * actually execute a task reminder. Origin falls back to the primary chat;
 * with neither, the fire is dropped with a log line.
 */
export function makeReminderFire(deps: RoutineFireDeps) {
  return (ev: { id: number; text: string; channel: string; chatId: string }): void => {
    const to = deliveryChat(ev, deps);
    if (!to) {
      deps.log(`reminder ${ev.id} skipped: no deliverable origin chat and no primary chat`);
      return;
    }
    const { channel, chatId, redirected } = to;
    if (redirected) {
      deps.log(`reminder ${ev.id} redirected: ${ev.channel} cannot receive a reply → ${channel}:${chatId}`);
    }
    void deps.onMessage({ channel, chatId, text: reminderPrompt(ev.text) })
      .catch((err) => deps.log(`reminder ${ev.id} failed: ${(err as Error).message}`));
  };
}
