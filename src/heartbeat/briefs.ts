// src/heartbeat/briefs.ts
import type { Store } from "../store/db.js";
import type { AiosEvent, EventBus } from "../events.js";
import type { VaultWriter } from "../vault/writer.js";
import { localParts } from "./clock.js";

export interface BriefData {
  anchor: "morning" | "evening";
  pendingApprovals: Array<{ id: string; type: string; preview: string; expires_at: string; expiringSoon: boolean }>;
  graduationProposals: Array<{ id: string; preview: string }>;
  autonomousDigest: Array<{ type: string; count: number }>;
  jobsFinished: Array<{ title: string; status: string }>;
  jobsFailed: Array<{ title: string; error: string }>;
  trustChanges: Array<{ type: string; state: string }>;
  remindersToday: Array<{ id: number; text: string; due_at: string }>;
  sinceLastBrief: string | null;
}

const TWELVE_H = 12 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

/** Local YYYY-MM-DD for an ISO timestamp. */
function localDateOf(iso: string): string {
  return localParts(new Date(iso)).date;
}

export function assembleBrief(
  store: Store,
  anchor: "morning" | "evening",
  nowIso: string,
  sinceTs: string | null,
): BriefData {
  const nowMs = Date.parse(nowIso);

  const pending = store.listActions("proposed");
  const pendingApprovals = pending
    .filter((a) => a.type !== "trust.promote")
    .map((a) => ({
      id: a.id, type: a.type, preview: a.preview, expires_at: a.expires_at,
      expiringSoon: Date.parse(a.expires_at) - nowMs < TWELVE_H,
    }));
  const graduationProposals = pending
    .filter((a) => a.type === "trust.promote")
    .map((a) => ({ id: a.id, preview: a.preview }));

  const autoCounts = new Map<string, number>();
  const jobsFinished: BriefData["jobsFinished"] = [];
  const jobsFailed: BriefData["jobsFailed"] = [];
  const trustChanges: BriefData["trustChanges"] = [];
  if (sinceTs) {
    for (const row of store.listEventsSince(sinceTs)) {
      let event: AiosEvent;
      try {
        event = JSON.parse(row.payload) as AiosEvent;
      } catch {
        continue;
      }
      if (event.type === "action.executed" && event.auto && event.ok) {
        autoCounts.set(event.actionType, (autoCounts.get(event.actionType) ?? 0) + 1);
      } else if (event.type === "job.status") {
        const title = store.getJob(event.jobId)?.title ?? event.jobId;
        if (event.status === "failed") jobsFailed.push({ title, error: event.error ?? "unknown" });
        else if (event.status === "done") jobsFinished.push({ title, status: event.status });
      } else if (event.type === "trust.changed") {
        trustChanges.push({ type: event.actionType, state: event.state });
      }
    }
  }

  // morning: reminders due today; evening: due tomorrow (local dates)
  const targetDate = localDateOf(
    anchor === "morning" ? nowIso : new Date(nowMs + DAY).toISOString(),
  );
  const remindersToday = store
    .listReminders("pending")
    .filter((r) => localDateOf(r.due_at) === targetDate)
    .map((r) => ({ id: r.id, text: r.text, due_at: r.due_at }));

  return {
    anchor,
    pendingApprovals,
    graduationProposals,
    autonomousDigest: [...autoCounts.entries()].map(([type, count]) => ({ type, count })),
    jobsFinished,
    jobsFailed,
    trustChanges,
    remindersToday,
    sinceLastBrief: sinceTs,
  };
}

export function isEmptyBrief(d: BriefData): boolean {
  return (
    d.pendingApprovals.length === 0 &&
    d.graduationProposals.length === 0 &&
    d.autonomousDigest.length === 0 &&
    d.jobsFinished.length === 0 &&
    d.jobsFailed.length === 0 &&
    d.trustChanges.length === 0 &&
    d.remindersToday.length === 0
  );
}

/** Vault note: human narration on top, machine-readable sections below. */
export function renderBriefNote(d: BriefData, narration: string): string {
  const lines: string[] = [narration, ""];
  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, ...rows.map((r) => `- ${r}`), "");
  };
  section("Pending approvals", d.pendingApprovals.map(
    (a) => `[${a.id}] ${a.type} — ${a.preview}${a.expiringSoon ? " ⚠ expiring soon" : ""}`,
  ));
  section("Graduation proposals", d.graduationProposals.map((g) => `[${g.id}] ${g.preview}`));
  section("Autonomous actions", d.autonomousDigest.map((x) => `${x.type} × ${x.count}`));
  section("Jobs finished", d.jobsFinished.map((j) => `${j.title} (${j.status})`));
  section("Jobs failed", d.jobsFailed.map((j) => `${j.title} — ${j.error}`));
  section("Trust changes", d.trustChanges.map((t) => `${t.type} → ${t.state}`));
  section(d.anchor === "morning" ? "Reminders today" : "Reminders tomorrow",
    d.remindersToday.map((r) => `#${r.id} ${r.text} (${r.due_at})`));
  return lines.join("\n");
}

export interface BriefRunnerDeps {
  store: Store;
  bus: EventBus;
  vault: VaultWriter;
  /** Moderator narration: (anchor, BriefData JSON) → chat-ready text. Only called when primary is set and the brief is non-empty. */
  narrate: (anchor: "morning" | "evening", dataJson: string) => Promise<string>;
  /** Channel delivery. */
  send: (channel: string, chatId: string, text: string) => Promise<void>;
  primary?: { channel: string; chatId: string };
  log?: (line: string) => void;
  nowFn?: () => Date;
}

export async function runBrief(deps: BriefRunnerDeps, anchor: "morning" | "evening"): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const since = deps.store.kvGet("brief:last-ts") ?? null;
  const data = assembleBrief(deps.store, anchor, now.toISOString(), since);
  deps.store.kvSet("brief:last-ts", now.toISOString()); // window always advances — no overlaps, no gaps

  const empty = isEmptyBrief(data);
  if (empty && anchor === "evening") {
    deps.log?.("evening brief skipped (empty)");
    return;
  }

  let narration: string;
  if (empty) {
    narration = "Quiet night. Nothing needs you.";
  } else if (!deps.primary) {
    narration = "(no primary chat configured — raw brief below)";
  } else {
    try {
      narration = await deps.narrate(anchor, JSON.stringify(data));
    } catch (err) {
      narration = `(narration failed: ${(err as Error).message} — raw brief below)`;
      deps.log?.(`brief narration failed: ${(err as Error).message}`);
    }
  }

  const notePath = `briefs/${localParts(now).date}-${anchor}.md`;
  deps.vault.writeNote(notePath, renderBriefNote(data, narration));

  if (deps.primary) {
    try {
      await deps.send(deps.primary.channel, deps.primary.chatId, narration);
    } catch (err) {
      deps.log?.(`brief delivery failed: ${(err as Error).message}`);
    }
  }

  deps.bus.emit({
    type: "brief.sent",
    anchor,
    chatKey: deps.primary ? `${deps.primary.channel}:${deps.primary.chatId}` : null,
  });
}
