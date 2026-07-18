// src/heartbeat/briefs.ts
import type { Store } from "../store/db.js";
import type { AiosEvent, EventBus } from "../events.js";
import type { VaultWriter } from "../vault/writer.js";
import { wallVerdict, type Label, type Policy } from "../kernel/policy.js";
import { localParts } from "./clock.js";
import { openLoopsForBrief, type OpenLoops } from "../lifeops/ops.js";

export interface BriefData {
  anchor: "morning" | "evening";
  pendingApprovals: Array<{ id: string; type: string; preview: string; expires_at: string; expiringSoon: boolean }>;
  graduationProposals: Array<{ id: string; preview: string }>;
  autonomousDigest: Array<{ type: string; count: number }>;
  jobsFinished: Array<{ title: string; status: string }>;
  jobsFailed: Array<{ title: string; error: string }>;
  trustChanges: Array<{ type: string; state: string }>;
  remindersToday: Array<{ id: number; text: string; due_at: string }>;
  mailDigest: Array<{ account: string; count: number; senders: string[] }>;
  meetings: Array<{ account: string; summary: string; start: string; link: string | null }>;
  /** Google accounts whose watcher is failing (revoked token etc.) — filled by runBrief, not assembleBrief. */
  sensesNeedingReauth: Array<{ name: string; reason: string }>;
  sinceLastBrief: string | null;
  /** Ranked initiatives from the nightly dream cycle — morning brief only. */
  dreamInitiatives?: Array<{ title: string; why: string; suggestion: string }>;
  /** Overnight research tasks from the speculate pass — morning brief only. */
  speculateResults?: Array<{ title: string; status: "done" | "failed" | "running"; ref: string | null }>;
  /** Generic count of pending email drafts — morning brief only; detail goes via a private send, never here. */
  emailDraftsPending?: number;
  /** Private task list — morning brief only; overdue + due-today + open count. */
  openLoops?: OpenLoops;
  /** Department lead standups (standup mail to hermes) — morning brief only. Lead name identifies the dept. */
  standups?: Array<{ lead: string; text: string }>;
  /** Hermes's other unread mail (reports/notes), one line each — morning brief only. */
  hermesMail?: Array<{ from: string; kind: string; line: string }>;
  /** Ids of the hermes mail consumed by THIS brief — runBrief marks exactly these read. */
  briefedMailIds?: string[];
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
  /** Agents in privateMemo departments (finance) — their mail never enters the vaulted, recall-
   *  indexed brief (mirrors the standup source carve-out; closes the money-wall leak via Mailroom). */
  privateAgents: Set<string> = new Set(),
): BriefData {
  const nowMs = Date.parse(nowIso);

  const pending = store.listActions("proposed");
  const pendingApprovals = pending
    .filter((a) => a.type !== "trust.promote" && !a.type.startsWith("email."))
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
  const mailByAccount = new Map<string, Map<string, number>>(); // account → domain → count
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
      } else if (event.type === "goal.status") {
        const title = store.getGoal(event.goalId)?.title ?? event.goalId;
        if (event.status === "failed") jobsFailed.push({ title, error: event.error ?? "unknown" });
        else if (event.status === "done") jobsFinished.push({ title, status: event.status });
      } else if (event.type === "trust.changed") {
        trustChanges.push({ type: event.actionType, state: event.state });
      } else if (event.type === "mail.received") {
        // Only count emails actually received after the last brief window.
        // The DB event ts reflects when the watcher processed the message (which
        // may lag after a backlog catch-up), so we use receivedAt from the payload.
        if (sinceTs && event.receivedAt < sinceTs) continue;
        const domain = event.from.match(/@([^>\s]+)/)?.[1] ?? event.from;
        const acc = mailByAccount.get(event.account) ?? new Map<string, number>();
        acc.set(domain, (acc.get(domain) ?? 0) + 1);
        mailByAccount.set(event.account, acc);
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

  const targetDateMeetings = localDateOf(
    anchor === "morning" ? nowIso : new Date(nowMs + DAY).toISOString(),
  );
  const meetings: BriefData["meetings"] = [];
  for (const row of store.kvByPrefix("gcal:")) {
    const m = /^gcal:(.+):snapshot$/.exec(row.key);
    if (!m) continue;
    let snap: Record<string, { summary: string; start: string; link: string | null }>;
    try {
      snap = JSON.parse(row.value) as never;
    } catch {
      continue;
    }
    for (const entry of Object.values(snap)) {
      if (localDateOf(entry.start) === targetDateMeetings) {
        meetings.push({ account: m[1], summary: entry.summary, start: entry.start, link: entry.link ?? null });
      }
    }
  }
  meetings.sort((a, b) => a.start.localeCompare(b.start));

  let dreamInitiatives: BriefData["dreamInitiatives"];
  if (anchor === "morning") {
    try {
      const raw = store.kvGet("dream:latest");
      if (raw) {
        const parsed = JSON.parse(raw) as { date?: string; initiatives?: BriefData["dreamInitiatives"] };
        if (parsed.date === localDateOf(nowIso) && parsed.initiatives?.length) dreamInitiatives = parsed.initiatives;
      }
    } catch { /* stale/bad value → omit the section */ }
  }

  let speculateResults: BriefData["speculateResults"];
  if (anchor === "morning") {
    try {
      const raw = store.kvGet("speculate:latest");
      if (raw) {
        const parsed = JSON.parse(raw) as { date?: string; tasks?: Array<{ title: string; slug: string; id: string }> };
        if (parsed.date === localDateOf(nowIso) && parsed.tasks?.length) {
          speculateResults = parsed.tasks.map((t) => {
            const goal = store.getGoal(t.id);
            // queued, running, or job not yet written → "running" (brief shows in-progress)
            const status: "done" | "failed" | "running" =
              goal?.status === "done" ? "done" : goal?.status === "failed" ? "failed" : "running";
            // Use the job's real persisted dir — never reconstruct from a date (UTC vs local drift).
            const ref = status === "done" && goal?.goal_dir ? `goals/${goal.goal_dir}/report.md` : null;
            return { title: t.title, status, ref };
          });
        }
      }
    } catch { /* stale/bad value → omit the section */ }
  }

  let emailDraftsPending = 0;
  if (anchor === "morning") emailDraftsPending = pending.filter((a) => a.type.startsWith("email.")).length;

  let openLoops: BriefData["openLoops"];
  if (anchor === "morning") {
    const ol = openLoopsForBrief(store.listTasks("open"), localDateOf(nowIso));
    if (ol.openCount) openLoops = ol;
  }

  let standups: BriefData["standups"];
  let hermesMail: BriefData["hermesMail"];
  let briefedMailIds: BriefData["briefedMailIds"];
  if (anchor === "morning") {
    // Drop private-dept senders before anything reaches the vaulted/indexed brief.
    const unread = store.unreadMailFor("hermes").filter((m) => !privateAgents.has(m.from_agent));
    const su = unread.filter((m) => m.kind === "standup")
      .map((m) => ({ lead: m.from_agent, text: m.body.replace(/\n+/g, " / ").slice(0, 400) }));
    if (su.length) standups = su;
    const other = unread.filter((m) => m.kind !== "standup")
      .map((m) => ({ from: m.from_agent, kind: m.kind, line: (m.body.split("\n")[0] ?? "").slice(0, 120) }));
    if (other.length) hermesMail = other;
    if (unread.length) briefedMailIds = unread.map((m) => m.id);
  }

  return {
    anchor,
    pendingApprovals,
    graduationProposals,
    autonomousDigest: [...autoCounts.entries()].map(([type, count]) => ({ type, count })),
    jobsFinished,
    jobsFailed,
    trustChanges,
    remindersToday,
    mailDigest: [...mailByAccount.entries()]
      .map(([account, domains]) => ({
        account,
        count: [...domains.values()].reduce((a, b) => a + b, 0),
        senders: [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, c]) => `${d} × ${c}`),
      }))
      .sort((a, b) => a.account.localeCompare(b.account)),
    meetings,
    sensesNeedingReauth: [], // assembleBrief stays pure — runBrief injects live degraded state
    sinceLastBrief: sinceTs,
    dreamInitiatives,
    speculateResults,
    emailDraftsPending,
    openLoops,
    standups,
    hermesMail,
    briefedMailIds,
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
    d.remindersToday.length === 0 &&
    d.mailDigest.length === 0 &&
    d.meetings.length === 0 &&
    d.sensesNeedingReauth.length === 0 &&
    (d.dreamInitiatives?.length ?? 0) === 0 &&
    (d.speculateResults?.length ?? 0) === 0 &&
    (d.emailDraftsPending ?? 0) === 0 &&
    ((d.openLoops?.overdue.length ?? 0) + (d.openLoops?.dueToday.length ?? 0)) === 0 &&
    (d.standups?.length ?? 0) === 0 &&
    (d.hermesMail?.length ?? 0) === 0
  );
}

/** Vault note: human narration on top, machine-readable sections below. */
export function renderBriefNote(d: BriefData, narration: string): string {
  const lines: string[] = [narration, ""];
  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    lines.push(`## ${title}`, ...rows.map((r) => `- ${r}`), "");
  };
  section("⚠ Senses needing re-auth", d.sensesNeedingReauth.map((s) => {
    const cmd = s.name === "bunq" ? "python3 scripts/bunq-setup.py" : `npx tsx scripts/google-auth.ts ${s.name}`;
    return `re-auth needed: ${s.name} (${s.reason}) — run: ${cmd}`;
  }));
  section("Pending approvals", d.pendingApprovals.map(
    (a) => `[${a.id}] ${a.type} — ${a.preview}${a.expiringSoon ? " ⚠ expiring soon" : ""}`,
  ));
  section("Graduation proposals", d.graduationProposals.map((g) => `[${g.id}] ${g.preview}`));
  section("Autonomous actions", d.autonomousDigest.map((x) => `${x.type} × ${x.count}`));
  section("Jobs finished", d.jobsFinished.map((j) => `${j.title} (${j.status})`));
  section("Jobs failed", d.jobsFailed.map((j) => `${j.title} — ${j.error}`));
  section("Trust changes", d.trustChanges.map((t) => `${t.type} → ${t.state}`));
  section("Mail", d.mailDigest.map((x) => `${x.account}: ${x.count} new (${x.senders.join(", ")})`));
  section(d.anchor === "morning" ? "Meetings today" : "Meetings tomorrow",
    d.meetings.map((mt) => `${mt.start.slice(11, 16)} ${mt.summary} (${mt.account})${mt.link ? ` — ${mt.link}` : ""}`));
  section(d.anchor === "morning" ? "Reminders today" : "Reminders tomorrow",
    d.remindersToday.map((r) => `#${r.id} ${r.text} (${r.due_at})`));
  section("Dream — worth considering", (d.dreamInitiatives ?? []).map((i) => `${i.title} — ${i.suggestion}`));
  section("Speculate — researched overnight", (d.speculateResults ?? []).map((r) =>
    r.status === "done" ? (r.ref ? `${r.title} — ${r.ref}` : r.title)
      : r.status === "failed" ? `${r.title} — failed` : `${r.title} — still running`,
  ));
  section("Speculate — email drafts", (d.emailDraftsPending ?? 0) > 0
    ? [`${d.emailDraftsPending} reply draft(s) await approval (details sent privately)`] : []);
  {
    const ol = d.openLoops;
    const rows = [
      ...(ol?.overdue ?? []).map((t) => `⚠ overdue: ${t.title} (was due ${t.due_date})`),
      ...(ol?.dueToday ?? []).map((t) => `due today: ${t}`),
    ];
    if (ol && rows.length) rows.push(`${ol.openCount} open loops total`);
    section("Open loops", rows);
  }
  section("Standups", (d.standups ?? []).map((s) => `${s.lead}: ${s.text}`));
  section("Mailroom", (d.hermesMail ?? []).map((m) => `${m.from} (${m.kind}): ${m.line}`));
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
  /** Live degraded-sense snapshot (e.g. GoogleAccounts.degraded) — surfaced as a re-auth section. */
  degraded?: () => Array<{ name: string; reason: string }>;
  /** Info-flow checkpoint — its table verdict decides which senders' mail is excluded from the
   *  brief AND left unread (wall-deletion spec; replaced the privateAgents set). */
  policy?: Policy;
  /** Confidentiality label for a private agent's dept (index.ts derives from the registry). */
  labelOf?: (agent: string) => Label;
  log?: (line: string) => void;
  nowFn?: () => Date;
}

export async function runBrief(deps: BriefRunnerDeps, anchor: "morning" | "evening"): Promise<void> {
  const now = (deps.nowFn ?? (() => new Date()))();
  const since = deps.store.kvGet("brief:last-ts") ?? null;
  // The table is the wall (wall-deletion spec): a sender whose dept label the policy denies at
  // the brief sink is excluded from the brief AND left unread (never vaulted/indexed; not
  // silently consumed by the mark-read sweep). personal.finance denies brief — money-wall parity.
  const privateAgents = new Set<string>();
  for (const m of deps.store.unreadMailFor("hermes")) {
    if (privateAgents.has(m.from_agent)) continue;
    const label = deps.labelOf?.(m.from_agent) ?? "org.internal";
    if (wallVerdict(deps.policy, { labels: [label], sink: "brief" }, "brief:private-mail", m.body) === "deny") {
      privateAgents.add(m.from_agent);
    }
  }
  const data = assembleBrief(deps.store, anchor, now.toISOString(), since, privateAgents);
  data.sensesNeedingReauth = deps.degraded?.() ?? [];
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

  // Hermes's inbox is read via the morning brief — briefed mail is acknowledged. Private-dept
  // mail is excluded from the brief, so it is also left unread (not silently consumed here).
  if (anchor === "morning") {
    const briefed = data.briefedMailIds ?? [];
    if (briefed.length) {
      deps.store.markMailRead(briefed);
      deps.bus.emit({ type: "mail.read", ids: briefed });
    }
  }

  if (deps.primary) {
    try {
      await deps.send(deps.primary.channel, deps.primary.chatId, narration);
    } catch (err) {
      deps.log?.(`brief delivery failed: ${(err as Error).message}`);
    }
  }

  // Vector C: email-draft detail goes out privately (transport-only, never vaulted/indexed).
  if (anchor === "morning" && deps.primary) {
    const drafts = deps.store.listActions("proposed").filter((a) => a.type.startsWith("email."));
    if (drafts.length) {
      const detail = ["📧 Email drafts to review:", ...drafts.map((a) => `[${a.id}] ${a.preview} → /approve ${a.id}`)].join("\n");
      try {
        await deps.send(deps.primary.channel, deps.primary.chatId, detail);
      } catch (err) {
        deps.log?.(`email-draft detail send failed: ${(err as Error).message}`);
      }
    }
  }

  deps.bus.emit({
    type: "brief.sent",
    anchor,
    chatKey: deps.primary ? `${deps.primary.channel}:${deps.primary.chatId}` : null,
  });
}
