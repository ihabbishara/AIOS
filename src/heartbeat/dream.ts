import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store/db.js";
import type { AiosEvent } from "../events.js";
import { localParts } from "./clock.js";

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
    if (e.type === "goal.status" && e.status === "failed") {
      failed.push(`  failed: ${store.getGoal(e.goalId)?.title ?? e.goalId} — ${e.error ?? "unknown"}`);
    }
  }
  if (failed.length) sections.push(`JOBS:\n${failed.join("\n")}`);

  return sections.join("\n\n");
}

export interface DreamDeps {
  store: Store;
  /** Injected one-shot ranker. The real one is `dreamRankLLM`; tests pass a stub. */
  rank: (digest: string, last: Initiative[]) => Promise<Initiative[]>;
  topN: number;
  nowFn?: () => Date;
  log?: (line: string) => void;
}

/**
 * The nightly propose pass: compile observations → rank top-N → store kv `dream:latest`.
 * Read-only: never proposes an action, never writes the vault. Fail-silent (no write on
 * empty digest or ranker failure), so a bad night just yields no morning Dream section.
 */
export async function runDreamCycle(deps: DreamDeps): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const digest = collectObservations(deps.store, now);
  if (!digest.trim()) { deps.log?.("dream: nothing to observe"); return; }

  let last: Initiative[] = [];
  try {
    const prev = deps.store.kvGet("dream:latest");
    if (prev) last = (JSON.parse(prev).initiatives ?? []) as Initiative[];
  } catch { /* bad prior value → no anti-repeat context */ }

  let initiatives: Initiative[];
  try {
    initiatives = await deps.rank(digest, last);
  } catch (err) {
    deps.log?.(`dream rank failed: ${(err as Error).message}`);
    return; // fail-silent
  }
  if (!Array.isArray(initiatives) || !initiatives.length) return;

  const top = initiatives.slice(0, deps.topN);
  deps.store.kvSet("dream:latest", JSON.stringify({ date: localParts(now).date, initiatives: top }));
}

/** Real one-shot LLM ranker (chief-of-staff persona, JSON-schema output). Mirrors the distiller's curateLLM. */
export function dreamRankLLM(model: string | undefined): (digest: string, last: Initiative[]) => Promise<Initiative[]> {
  return async (digest, last) => {
    const antiRepeat = last.map((i) => `- ${i.title}`).join("\n") || "(none)";
    const q = query({
      prompt: `Observations:\n${digest}\n\nYou suggested these recently — do NOT repeat unless still pressing:\n${antiRepeat}\n\nRank the most worthwhile initiatives for me to consider.`,
      options: {
        systemPrompt:
          "You are the operator's chief of staff. From the observations, pick the few things most worth their " +
          "attention right now. For each: a short title, why it matters now, and one concrete suggested next step. " +
          "Do NOT repeat recently-suggested or already-dismissed items. Be specific and brief.",
        allowedTools: [],
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        ...(model ? { model } : {}),
        outputFormat: {
          type: "json_schema" as const,
          schema: {
            type: "object",
            properties: {
              initiatives: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, why: { type: "string" }, suggestion: { type: "string" } },
                  required: ["title", "why", "suggestion"],
                  additionalProperties: false,
                },
              },
            },
            required: ["initiatives"],
            additionalProperties: false,
          },
        },
      },
    });
    for await (const msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") {
          const out = (msg.structured_output as { initiatives?: Initiative[] } | undefined)?.initiatives;
          if (Array.isArray(out)) return out;
        }
        break;
      }
    }
    return [];
  };
}
