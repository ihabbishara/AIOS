// ui2/src/views/Mail.tsx — the org's pulse: a daily check-in ritual, the work traffic
// that carries goals, and your own correspondence (spec 2026-08-03-mail-pulse-design).
//
// This view used to show api.mailMine() only — threads touching `user` — which is 8 of the
// 72 mail rows, the newest 18 days old. The ritual that runs every morning was invisible.
// It now reads the full stream and organises it by DAY, because 62% of mail is a standup
// arriving 1–3 times a day and the day is the unit the data is actually shaped in.
//
// No motion anywhere in here on purpose: every row is a past event and nothing in Mail is
// ever in flight, so under "motion is real or it doesn't exist" this surface earns none.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api, type MailView, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Dot, Empty, PageHeader, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { CLOCK_TEXT, CLOCK_TOKEN } from "../lib/goal-clock.js";
import { ts } from "../lib/format.js";
import {
  groupByDay, exchangesOf, dayKey, windowStartIso,
  type DayCell, type DayEntry, type Exchange,
} from "../lib/standup.js";

const WINDOW_DAYS = 30;

export function Mail({ events, route }: { events: StoredEvent[]; route: Route }) {
  const [head, ...rest] = route.parts;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="page">
        {head === "day" && rest[0]
          ? <DayDetail date={rest[0]} events={events} />
          : head === "x" && rest[0]
            ? <ExchangeDetail exchangeKey={rest[0]} events={events} />
            : head
              ? <Thread threadId={head} events={events} />
              : <Pulse events={events} />}
      </div>
    </div>
  );
}

/** The whole surface is one 30-day window: the fetch asks for exactly the range the strip
 *  draws, so no row cap can quietly drop the oldest days. A plain `limit` could not do this —
 *  it counts from the newest row backwards and knows nothing about where the window starts. */
function usePulse(events: StoredEvent[]) {
  return useLiveQuery(
    () => api.mail(undefined, undefined, windowStartIso(new Date(), WINDOW_DAYS)),
    events, T.agentMail,
  );
}

function Pulse({ events }: { events: StoredEvent[] }) {
  const { data: mail } = usePulse(events);
  if (!mail) return <Empty>Loading…</Empty>;

  const cells = groupByDay(mail, new Date(), WINDOW_DAYS);
  const exchanges = exchangesOf(mail);
  const checked = cells.filter((c) => c.state === "checked").length;
  const standups = mail.filter((m) => m.kind === "standup").length;

  if (standups === 0 && exchanges.length === 0) {
    return (
      <>
        <PageHeader title="Mail" />
        <Empty>No mail yet — agents check in each morning, and write here when work changes hands.</Empty>
      </>
    );
  }

  return (
    <div>
      <PageHeader title="Mail" meta={`checked in ${checked} of ${cells.length} days`} />

      {standups > 0 && <PulseStrip cells={cells} />}

      {[...cells].reverse().map((c) => <DayGroup key={c.date} cell={c} />)}

      {exchanges.length > 0 && (
        <div className="mt-8">
          <BandLabel label="Work" count={exchanges.length} />
          {exchanges.map((x) => <ExchangeRow key={x.key} x={x} />)}
        </div>
      )}

      <Yours events={events} />
    </div>
  );
}

function BandLabel({ label, count }: { label: string; count: number }) {
  return (
    <div className="label mb-2 flex items-center gap-2">
      {label}
      <span className="h-px flex-1 bg-line" />
      <span className="font-mono text-[10px] text-dim">{count}</span>
    </div>
  );
}

/** One column per day across the window. Height is not a chart — check-ins run 1–3, so
 *  the column is read by its marks. A silent day keeps its column and shows a baseline
 *  tick, because the gap IS the information. */
function PulseStrip({ cells }: { cells: DayCell[] }) {
  const today = dayKey(new Date().toISOString());
  return (
    <div className="panel p-3 mb-7">
      <div className="flex gap-[3px] items-end h-14">
        {cells.map((c) => (
          <button
            key={c.date}
            onClick={() => navigate(`mail/day/${c.date}`)}
            title={`${c.date} — ${c.state === "silent" ? "no standup" : `${c.entries.length} check-in${c.entries.length === 1 ? "" : "s"}${c.state === "failed" ? ", one or more failed" : ""}`}`}
            className="flex-1 h-full flex flex-col-reverse gap-[2px] justify-start rounded-sm hover:bg-raised transition-colors min-w-[6px]"
          >
            {c.state === "silent"
              ? <span className="h-[3px] rounded-[1px] bg-line" />
              : c.entries.map((e, i) => (
                <span key={i}
                  className={`h-2 rounded-[1px] ${
                    e.parsed.kind === "failed" ? CLOCK_TOKEN.blocked
                      : c.date === today ? CLOCK_TOKEN.now : CLOCK_TOKEN.past
                  }`} />
              ))}
          </button>
        ))}
      </div>
      <div className="flex justify-between mt-2 label">
        <span>{cells[0]?.date}</span>
        <span>today</span>
      </div>
    </div>
  );
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const y = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
  return date === y ? "Yesterday" : date;
}

function DayGroup({ cell }: { cell: DayCell }) {
  const today = dayKey(new Date().toISOString());
  const label = dayLabel(cell.date, today);
  return (
    <div className="mb-6">
      <div className="label mb-2 flex items-center gap-2">
        <button onClick={() => navigate(`mail/day/${cell.date}`)} className="hover:text-fg transition-colors">
          {label}
        </button>
        {label !== cell.date && <span className="font-mono text-[10px] normal-case tracking-normal">{cell.date}</span>}
        <span className="h-px flex-1 bg-line" />
        <span className="font-mono text-[10px] text-dim">
          {cell.state === "silent" ? "silent" : `${cell.entries.length}`}
        </span>
      </div>
      {cell.state === "silent"
        ? <div className="text-[11.5px] text-dim px-1">No standup — the org did not check in.</div>
        : cell.entries.map((e, i) => <StandupRow key={`${e.agent}-${i}`} e={e} />)}
    </div>
  );
}

const FIELDS: Array<{ key: "done" | "today" | "blockers"; label: string }> = [
  { key: "done", label: "Done" },
  { key: "today", label: "Today" },
  { key: "blockers", label: "Blockers" },
];

function StandupRow({ e, full = false }: { e: DayEntry; full?: boolean }) {
  return (
    <div className="card px-3 py-2.5 mb-1.5">
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-strong">{e.agent}</span>
        {e.parsed.kind === "failed" && <Tag tone="accent">standup failed</Tag>}
        <span className="ml-auto font-mono text-[10px] text-dim">{ts(e.at)}</span>
      </div>

      {e.parsed.kind === "checkin" && (
        <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1">
          {FIELDS.map(({ key, label }) => (
            <Fragment key={key}>
              <span className="label pt-[3px]">{label}</span>
              <span className={`text-[12px] leading-relaxed whitespace-pre-wrap ${full ? "" : "line-clamp-3"}`}>
                {e.parsed.kind === "checkin" ? e.parsed.fields[key] || "—" : ""}
              </span>
            </Fragment>
          ))}
        </div>
      )}

      {e.parsed.kind === "failed" && (
        <div className={`text-[12px] ${CLOCK_TEXT.blocked}`}>{e.parsed.reason}</div>
      )}

      {/* Agent-authored text that did not parse renders verbatim as preformatted text —
          never as markup, and never silently dropped. */}
      {e.parsed.kind === "raw" && (
        <pre className="text-[11.5px] text-dim whitespace-pre-wrap font-mono leading-relaxed">{e.parsed.body}</pre>
      )}
    </div>
  );
}

function ExchangeRow({ x }: { x: Exchange }) {
  const head = x.request ?? x.reports[0];
  if (!head) return null;
  return (
    <button onClick={() => navigate(`mail/x/${x.key}`)}
      className="card card-hover w-full text-left px-3 py-2.5 mb-1.5 min-h-11">
      <div className="flex items-baseline gap-2">
        <span className="text-strong">{head.from}</span>
        <span className="text-dim">→</span>
        <span className="text-strong">{head.to}</span>
        <Tag tone={toneOfStatus(head.status)}>{head.kind}</Tag>
        <span className="ml-auto font-mono text-[10px] text-dim">{ts(x.at)}</span>
      </div>
      <div className="text-[12px] text-dim truncate mt-1">{head.body}</div>
      <div className="flex gap-2 items-center mt-1">
        {x.reports.length > 0 && (
          <span className="text-[10.5px] text-dim">
            {x.reports.length} report{x.reports.length === 1 ? "" : "s"} back
          </span>
        )}
        {x.goalId && <span className={`text-[10.5px] ${CLOCK_TEXT.next}`}>goal ↗</span>}
      </div>
    </button>
  );
}

// ── detail ────────────────────────────────────────────────────────────────────

function BackTo({ children }: { children: ReactNode }) {
  return (
    <button onClick={() => navigate("mail")} className="label hover:text-fg text-left mb-3">← {children}</button>
  );
}

function DayDetail({ date, events }: { date: string; events: StoredEvent[] }) {
  const { data: mail } = usePulse(events);
  if (!mail) return <Empty>Loading…</Empty>;
  const cell = groupByDay(mail, new Date(), WINDOW_DAYS).find((c) => c.date === date);
  return (
    <div className="max-w-3xl">
      <BackTo>mail</BackTo>
      <PageHeader title={date} meta={cell && cell.state !== "silent" ? `${cell.entries.length} checked in` : "no standup"} />
      {!cell || cell.state === "silent"
        ? <Empty>No standup on {date} — the org did not check in.</Empty>
        : cell.entries.map((e, i) => <StandupRow key={`${e.agent}-${i}`} e={e} full />)}
    </div>
  );
}

function ExchangeDetail({ exchangeKey, events }: { exchangeKey: string; events: StoredEvent[] }) {
  const { data: mail } = usePulse(events);
  if (!mail) return <Empty>Loading…</Empty>;
  const x = exchangesOf(mail).find((e) => e.key === exchangeKey);
  if (!x) return (<><BackTo>mail</BackTo><Empty>That exchange is no longer in the window.</Empty></>);
  const msgs = [x.request, ...x.reports].filter((m): m is MailView => m != null);
  return (
    <div className="max-w-3xl">
      <BackTo>mail</BackTo>
      <PageHeader title="Exchange" meta={`${msgs.length} message${msgs.length === 1 ? "" : "s"}`}>
        {x.goalId && <Button onClick={() => navigate(`goals/${x.goalId}`)}>open goal ↗</Button>}
      </PageHeader>
      {msgs.map((m) => (
        <div key={m.id} className="card px-3 py-2.5 mb-2">
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="text-strong">{m.from}</span>
            <span className="text-dim">→</span>
            <span className="text-strong">{m.to}</span>
            <Tag tone={toneOfStatus(m.status)}>{m.kind}</Tag>
            <span className="ml-auto font-mono text-[10px] text-dim">{ts(m.createdAt)}</span>
          </div>
          <pre className="text-[12px] whitespace-pre-wrap leading-relaxed font-sans">{m.body}</pre>
          {m.error && <div className="text-[11px] text-err mt-1">{m.error}</div>}
        </div>
      ))}
    </div>
  );
}

// ── yours: preserved, deliberately minimal (spec §5) ──────────────────────────

/** Your own correspondence and the write path. Out of scope for restyling this cycle;
 *  it lives here so Compose and the answer-resumes-a-parked-goal path keep an entry
 *  point now that the list is no longer an inbox. */
function Yours({ events }: { events: StoredEvent[] }) {
  const { data: mine } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const [composing, setComposing] = useState(false);
  const threads = mine?.threads ?? [];
  return (
    <div className="mt-8">
      <div className="label mb-2 flex items-center gap-2">
        Yours
        <span className="h-px flex-1 bg-line" />
        <Button onClick={() => setComposing((v) => !v)}>{composing ? "cancel" : "Compose"}</Button>
      </div>
      {composing && <Compose onDone={() => setComposing(false)} />}
      {threads.length === 0
        ? <div className="text-[11.5px] text-dim px-1">Nothing addressed to you.</div>
        : threads.map((t) => (
          <button key={t.threadId} onClick={() => navigate(`mail/${t.threadId}`)}
            className="card card-hover w-full text-left px-3 py-2 mb-1.5 flex items-center gap-2 min-h-11">
            {t.unread > 0 && <Dot tone="info" />}
            <span className={t.unread > 0 ? "text-bright font-semibold" : "text-strong"}>{t.lastFrom}</span>
            {t.pendingAsk > 0 && <Tag tone="accent">needs answer</Tag>}
            {t.refused > 0 && <span title="a message in this thread was refused">⚠</span>}
            <span className="text-dim truncate">{t.lastBody}</span>
            <span className="text-[10px] text-dim ml-auto shrink-0 font-mono">{ts(t.lastTs)}</span>
          </button>
        ))}
    </div>
  );
}

function Thread({ threadId, events }: { threadId: string; events: StoredEvent[] }) {
  const { data: thread, reload } = useLiveQuery(() => api.mailThreadView(threadId), events, T.agentMail, [threadId]);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  // Opening a thread marks your unread mail in it as read (spec §5 queue parity).
  useEffect(() => {
    if (!thread) return;
    const unread = thread.filter((m) => m.to === "user" && m.status === "unread");
    if (unread.length > 0) void Promise.all(unread.map((m) => api.markMailRead(m.id))).then(reload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.length]);

  if (!thread) return <Empty>Loading…</Empty>;
  const last = thread[thread.length - 1];
  const pendingAsk = thread.find((m) => m.kind === "request" && m.to === "user" && m.status === "awaiting-human");

  const send = async () => {
    if (!reply.trim() || !last) return;
    setError("");
    try {
      if (pendingAsk) {
        await api.answerMail(pendingAsk.id, reply.trim()); // answering resumes the parked goal
      } else {
        const res = await api.composeMail({ to: last.from === "user" ? last.to : last.from, body: reply.trim(), threadId, inReplyTo: last.id });
        if ("refusal" in res && !res.ok) { setError(res.refusal); return; }
      }
      setReply("");
      reload();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="max-w-2xl flex flex-col gap-3">
      <button onClick={() => navigate("mail")} className="label hover:text-fg text-left">← mail</button>
      {thread.map((m) => (
        <div key={m.id} className={m.from === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
          <div className="label mb-1 flex gap-2 items-center">
            {m.from} → {m.to}
            <Tag tone={toneOfStatus(m.status)}>{m.kind}</Tag>
            {m.goalId && (
              <button onClick={() => navigate(`goals/${m.goalId}`)} className="underline underline-offset-2 hover:text-fg">goal</button>
            )}
            <span className="ml-auto">{ts(m.createdAt)}</span>
          </div>
          <div className={`border rounded-lg px-3 py-2 whitespace-pre-wrap leading-relaxed bg-surface ${
            m.status === "refused" ? "border-err/40" : m.from === "user" ? "border-agent/40" : "border-line"
          }`}>
            {m.body}
            {m.error && <div className="text-[11px] text-err mt-1">{m.error}</div>}
          </div>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={pendingAsk ? "Your answer resumes the goal…" : "Reply…"}
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim" />
        <Button variant="primary" onClick={send}>{pendingAsk ? "Answer" : "Reply"}</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}

function Compose({ onDone }: { onDone: () => void }) {
  const { data: org } = useFetch(() => api.org(), []);
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const agents = (org ?? []).flatMap((d) => d.agents.map((a) => ({ name: a.name, private: a.visibility === "private" })));

  const send = async () => {
    if (!to || !body.trim()) return;
    setError("");
    try {
      const res = await api.composeMail({ to, body: body.trim() });
      if ("refusal" in res && !res.ok) { setError(res.refusal); return; }
      onDone();
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="panel p-4 mb-4 flex flex-col gap-2">
      <SectionLabel>New mail</SectionLabel>
      <select value={to} onChange={(e) => setTo(e.target.value)}
        className="bg-bg border border-line rounded-md px-2 py-1.5 text-[12px] outline-none w-64">
        <option value="">to…</option>
        {agents.map((a) => <option key={a.name} value={a.name}>{a.name}{a.private ? " (private)" : ""}</option>)}
      </select>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message…"
        className="bg-bg border border-line rounded-md px-3 py-2 h-28 outline-none focus:border-dim" />
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="flex gap-2 justify-end">
        <Button onClick={onDone}>Cancel</Button>
        <Button variant="primary" onClick={send}>Send</Button>
      </div>
    </div>
  );
}
