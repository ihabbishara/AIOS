// ui2/src/views/canvas/MailThread.tsx — thread view + reply box; memo mode for briefs.
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { Button, SectionLabel, Tag, Empty, toneOfStatus } from "../../components/ui.js";
import { ts } from "../../lib/format.js";

export function MailThreadCanvas({ item, events, onDone }: { item: AttentionItem; events: StoredEvent[]; onDone: () => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const memo = item.ref.brief === "1";
  const { data: thread, reload } = useLiveQuery(
    () => api.mailThreadView(item.ref.threadId), events, T.agentMail, [item.ref.threadId],
  );
  if (!thread) return <Empty>Loading…</Empty>;
  const last = thread[thread.length - 1];

  const send = async () => {
    if (!reply.trim() || busy || !last) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.composeMail({
        to: last.from === "user" ? last.to : last.from,
        body: reply.trim(), threadId: item.ref.threadId, inReplyTo: last.id,
      });
      if ("refusal" in res && !res.ok) setError(res.refusal);
      else { setReply(""); reload(); }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (memo) {
    return (
      <div className="max-w-2xl">
        <button onClick={onDone} className="label hover:text-fg mb-3">← Home</button>
        <SectionLabel>Brief</SectionLabel>
        {thread.filter((m) => m.from !== "user").map((m) => (
          <div key={m.id} className="panel p-5 mb-3 whitespace-pre-wrap leading-relaxed">{m.body}</div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-2xl flex flex-col gap-3">
      <SectionLabel>Thread</SectionLabel>
      {thread.map((m) => (
        <div key={m.id} className={m.from === "user" ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
          <div className="label mb-1 flex gap-2">
            {m.from} → {m.to} <Tag tone={toneOfStatus(m.status)}>{m.kind}</Tag>
            <span className="ml-auto">{ts(m.createdAt)}</span>
          </div>
          <div className="panel px-3 py-2 whitespace-pre-wrap leading-relaxed">{m.body}</div>
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <input
          value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`Reply to ${last?.from ?? ""}…`}
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim"
        />
        <Button variant="primary" disabled={busy} onClick={send}>{busy ? "…" : "Reply"}</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}
