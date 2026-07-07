// ui/src/views/Mail.tsx — the human's correspondence: inbox threads + compose (spec 2026-07-07).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MailView, type StoredEvent, type UserThreadView } from "../api.js";
import { usePoll } from "../hooks.js";

const AGENT_MAIL_EVENTS = new Set(["mail.sent", "mail.spawned", "mail.read", "mail.asked_user"]);

export function Mail({ events }: { events: StoredEvent[] }) {
  const lastMailEvt = useMemo(
    () => events.filter((e) => AGENT_MAIL_EVENTS.has(e.event.type)).at(-1)?.id,
    [events],
  );
  const { data: mine, reload } = usePoll(() => api.mailMine(), [lastMailEvt]);
  const { data: org } = usePoll(() => api.org(), []);
  const [open, setOpen] = useState<string | null>(null);
  const agents = useMemo(
    () => (org ?? []).flatMap((d) => d.agents.map((a) => ({ name: a.name, dept: d.department }))),
    [org],
  );

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="w-72 shrink-0 flex flex-col gap-3 min-h-0">
        <Compose agents={agents} onSent={(id) => { reload(); if (id) setOpen(id); }} />
        <div className="label">Threads</div>
        <div className="flex-1 overflow-auto flex flex-col gap-1">
          {(mine?.threads ?? []).map((t) => (
            <ThreadRow key={t.threadId} t={t} active={open === t.threadId} onOpen={() => setOpen(t.threadId)} />
          ))}
          {mine && mine.threads.length === 0 && <div className="text-dim text-[11px]">No correspondence yet.</div>}
        </div>
      </div>
      <div className="flex-1 min-w-0 overflow-auto">
        {open
          ? <ThreadDetail key={open} threadId={open} lastMailEvt={lastMailEvt} onChanged={reload} />
          : <div className="text-dim text-[11px] pt-8 text-center">Select a thread — or compose cold mail to any agent.</div>}
      </div>
    </div>
  );
}

function ThreadRow({ t, active, onOpen }: { t: UserThreadView; active: boolean; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={`text-left px-3 py-2 border ${active ? "border-phosphor bg-panel-2" : "border-line bg-panel hover:border-fg"}`}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className={t.unread > 0 ? "text-bright font-bold" : "text-fg"}>{t.lastFrom}</span>
        {t.unread > 0 && <span className="text-void bg-amber px-1 rounded-full text-[9px]">{t.unread}</span>}
        {t.pendingAsk > 0 && <span className="text-[10px]">🙋</span>}
        {t.refused > 0 && <span className="text-alert text-[10px]" title="a request in this thread was refused">⚠</span>}
        <span className="ml-auto text-dim text-[10px]">{t.lastTs.slice(5, 16)}</span>
      </div>
      <div className="text-dim text-[11px] truncate">{t.lastBody}</div>
    </button>
  );
}

function ThreadDetail({ threadId, lastMailEvt, onChanged }:
  { threadId: string; lastMailEvt: number | undefined; onChanged: () => void }) {
  const { data: msgs, reload } = usePoll(() => api.mailThreadView(threadId), [threadId, lastMailEvt]);
  // Human opened the thread = read (fire-and-forget per unread to-user message).
  // Track ids already sent so effect re-runs (triggered by our own mail.read events racing
  // an in-flight POST whose fetched snapshot is still "unread") don't re-POST the same id.
  const sentRead = useRef(new Set<string>());
  useEffect(() => {
    for (const m of msgs ?? []) {
      if (m.to === "user" && m.status === "unread" && !sentRead.current.has(m.id)) {
        sentRead.current.add(m.id);
        void api.markMailRead(m.id).catch(() => {});
      }
    }
  }, [msgs]);
  // Answered-ness isn't derivable client-side (MailView carries no inReplyTo) — show the box
  // for any awaiting-human message; the server's existing 409 guards double answers.
  const pendingAsk = (msgs ?? []).find((m) => m.to === "user" && m.status === "awaiting-human");
  const lastReport = [...(msgs ?? [])].reverse().find((m) => m.kind === "report" && m.to === "user");
  // Reply target = the last participant who isn't the user; server refuses unknowns anyway.
  const other = [...(msgs ?? [])].reverse().map((m) => (m.from === "user" ? m.to : m.from)).find((n) => n !== "user") ?? "";
  return (
    <div className="flex flex-col gap-2">
      {(msgs ?? []).map((m) => (
        <div key={m.id} className="border border-line bg-panel px-3 py-2">
          <div className="text-[11px] text-dim">
            <span className={m.from === "user" ? "text-cyan" : "text-amber"}>{m.from}</span>
            {" → "}{m.to} · {m.kind} · {m.createdAt.slice(0, 16)}
            {m.status === "refused" && <span className="text-alert"> · refused{m.error ? `: ${m.error}` : ""}</span>}
          </div>
          <div className="text-[12px] whitespace-pre-wrap">{m.body}</div>
        </div>
      ))}
      {pendingAsk && <AnswerBox mailId={pendingAsk.id} onDone={() => { reload(); onChanged(); }} />}
      <ReplyBox threadId={threadId} inReplyTo={lastReport?.id} other={other} onSent={() => { reload(); onChanged(); }} />
    </div>
  );
}

function AnswerBox({ mailId, onDone }: { mailId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    api.answerMail(mailId, text)
      .then(() => { setText(""); onDone(); })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="border border-cyan px-3 py-2 flex flex-col gap-1">
      <div className="label">🙋 answer this question</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
        className="bg-panel-2 border border-line px-2 py-1 text-[12px]" />
      <div className="flex items-center gap-2">
        <button onClick={send} disabled={busy || !text.trim()}
          className="text-[11px] border border-line px-3 py-1 hover:border-fg disabled:opacity-50">answer</button>
        {msg && <span className="text-alert text-[11px]">{msg}</span>}
      </div>
    </div>
  );
}

function ReplyBox({ threadId, inReplyTo, other, onSent }:
  { threadId: string; inReplyTo: string | undefined; other: string; onSent: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    api.composeMail({ to: other, body: text, threadId, inReplyTo })
      .then((r) => { if (!r.ok) setMsg(r.refusal); else { setText(""); onSent(); } })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="border border-line px-3 py-2 flex flex-col gap-1">
      <div className="label">reply → {other || "…"}</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
        className="bg-panel-2 border border-line px-2 py-1 text-[12px]" />
      <div className="flex items-center gap-2">
        <button onClick={send} disabled={busy || !text.trim() || !other}
          className="text-[11px] border border-line px-3 py-1 hover:border-fg disabled:opacity-50">send follow-up</button>
        {msg && <span className="text-alert text-[11px]">{msg}</span>}
      </div>
    </div>
  );
}

function Compose({ agents, onSent }: { agents: Array<{ name: string; dept: string }>; onSent: (id?: string) => void }) {
  const [to, setTo] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const send = () => {
    if (busy || !to || !body.trim()) return;
    setBusy(true);
    setMsg(null);
    api.composeMail({ to, body })
      .then((r) => {
        if (!r.ok) setMsg(r.refusal);
        else { setBody(""); setTo(""); setMsg("sent ✓"); onSent(r.id); }
      })
      .catch((e) => setMsg((e as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="border border-line bg-panel px-3 py-2 flex flex-col gap-1">
      <div className="label">compose</div>
      <select value={to} onChange={(e) => setTo(e.target.value)}
        className="bg-panel-2 border border-line px-2 py-1 text-[12px]">
        <option value="">to…</option>
        {agents.map((a) => <option key={a.name} value={a.name}>{a.name} ({a.dept})</option>)}
      </select>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={4000}
        placeholder="What should they do?" className="bg-panel-2 border border-line px-2 py-1 text-[12px]" />
      <div className="flex items-center gap-2">
        <button onClick={send} disabled={busy || !to || !body.trim()}
          className="text-[11px] border border-line px-3 py-1 hover:border-fg disabled:opacity-50">send</button>
        {msg && <span className={`text-[11px] ${msg === "sent ✓" ? "text-phosphor" : "text-alert"}`}>{msg}</span>}
      </div>
    </div>
  );
}
