// src/web/schedule-view.ts — GET /api/schedule builder + routine/anchor write validation (spec 2026-07-15).
import type { Store } from "../store/db.js";
import type { Config } from "../config.js";
import { parseRecurrence, nextFire } from "../heartbeat/routines.js";
import type { ScheduleView, AnchorView } from "./dto.js";

export const ANCHOR_NAMES = ["morning", "evening", "dream", "speculate", "standup"] as const;
export type AnchorName = (typeof ANCHOR_NAMES)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function anchorOverrideKey(name: string): string {
  return `anchor:${name}:hhmm`;
}

export function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && HHMM.test(s);
}

function anchorDefaults(config: Config): Record<AnchorName, string> {
  return {
    morning: config.anchorMorning,
    evening: config.anchorEvening,
    dream: config.anchorDream,
    speculate: config.anchorSpeculate,
    standup: config.anchorStandup,
  };
}

export interface RoutineFields {
  name?: string;
  prompt?: string;
  /** Normalized JSON of a validated Recurrence. */
  recurrence?: string;
  enabled?: boolean;
}

/** Validates POST (partial=false: name/prompt/recurrence required) and PATCH (partial=true) bodies. */
export function validateRoutineBody(
  body: unknown,
  partial: boolean,
): { ok: true; fields: RoutineFields } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  const fields: RoutineFields = {};
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim()) return { ok: false, error: "name must be a non-empty string" };
    fields.name = b.name.trim();
  }
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== "string" || !b.prompt.trim()) return { ok: false, error: "prompt must be a non-empty string" };
    fields.prompt = b.prompt.trim();
  }
  if (b.recurrence !== undefined) {
    const rec = parseRecurrence(b.recurrence);
    if (!rec) return { ok: false, error: "recurrence must be daily/weekdays/weekly/interval with valid fields" };
    fields.recurrence = JSON.stringify(rec);
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    fields.enabled = b.enabled;
  }
  if (!partial) {
    if (!fields.name) return { ok: false, error: "name is required" };
    if (!fields.prompt) return { ok: false, error: "prompt is required" };
    if (!fields.recurrence) return { ok: false, error: "recurrence is required" };
  }
  return { ok: true, fields };
}

export function buildScheduleView(store: Store, config: Config, now: Date): ScheduleView {
  const defaults = anchorDefaults(config);
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const anchors: AnchorView[] = ANCHOR_NAMES.map((name) => {
    const override = store.kvGet(anchorOverrideKey(name));
    return {
      name,
      hhmm: override ?? defaults[name],
      overridden: override !== undefined,
      firedToday: store.kvGet(`anchor:${name}:last`) === today,
    };
  });
  return {
    anchors,
    routines: store.listRoutines().map((r) => {
      const rec = parseRecurrence(r.recurrence);
      return {
        id: r.id,
        name: r.name,
        prompt: r.prompt,
        // rec is null only for hand-edited DB rows — surface something renderable.
        recurrence: rec ?? { kind: "daily" as const, hhmm: "00:00" },
        enabled: !!r.enabled,
        lastFiredAt: r.last_fired_at,
        nextFire: nextFire(now, r),
      };
    }),
    reminders: store.listReminders("pending").map((r) => ({
      id: r.id,
      text: r.text,
      dueAt: r.due_at,
      origin: `${r.origin_channel}:${r.origin_chat_id}`,
    })),
  };
}
