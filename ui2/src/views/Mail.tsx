// ui2/src/views/Mail.tsx — your correspondence: threads, detail bubbles, compose (spec §6 Mail).
import { useEffect, useState } from "react";
import { api, type StoredEvent } from "../api.js";
import { useFetch, useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { navigate, type Route } from "../lib/router.js";
import { Button, Empty, SectionLabel, Tag, toneOfStatus } from "../components/ui.js";
import { ts } from "../lib/format.js";

export function Mail({ events, route }: { events: StoredEvent[]; route: Route }) {
  const threadId = route.parts[0];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4">
      {threadId ? <Thread threadId={threadId} events={events} /> : <Threads events={events} />}
    </div>
  );
}

function Threads({ events }: { events: StoredEvent[] }) {
  const { data: mine } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const [composing, setComposing] = useState(false);
  if (!mine) return <Empty>Loading…</Empty>;
  return (
    <div className="max-w-3xl">
      <div className="flex items-center mb-4">
        <h1 className="text-[17px] font-bold text-bright">Mail</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setComposing(true)}>Compose</Button>
      </div>
      {composing && <Compose onDone={() => setComposing(false)} />}
      {mine.threads.map((t) => (
        <button key={t.threadId} onClick={() => navigate(`mail/${t.threadId}`)}
          className="card card-hover w-full text-left px-3 py-2.5 mb-2 flex items-baseline gap-2 min-h-11">
          <span className={t.unread > 0 ? "text-accent font-medium" : "text-strong"}>{t.lastFrom}</span>
          {t.pendingAsk > 0 && <span title="waiting on your answer">🙋</span>}
          {t.refused > 0 && <span title="refused">⚠</span>}
          <span className="text-dim truncate">{t.lastBody}</span>
          <span className="text-[10px] text-dim ml-auto shrink-0">{ts(t.lastTs)}</span>
        </button>
      ))}
      {mine.threads.length === 0 && <Empty>No mail yet.</Empty>}
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
