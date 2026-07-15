// ui2/src/views/canvas/Ask.tsx — question + parked-goal context + answer box (resumes via /api/mail/:id/answer).
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { Button, SectionLabel, Tag } from "../../components/ui.js";
import { MiniDag } from "../MiniDag.js";

export function AskCanvas({ item, events, onDone }: {
  item: AttentionItem; events: StoredEvent[]; onDone: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data: goal } = useLiveQuery(
    () => (item.ref.goalId ? api.goal(item.ref.goalId) : Promise.resolve(null)),
    events, T.goals, [item.ref.goalId],
  );

  const send = async () => {
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.answerMail(item.ref.mailId, answer.trim());
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Ask</SectionLabel>
        <Tag tone="accent">{item.meta}</Tag>
      </div>
      <div className="panel p-4 whitespace-pre-wrap leading-relaxed">
        {item.title}
      </div>
      {goal && (
        <div>
          <SectionLabel>Blocked goal · {goal.title}</SectionLabel>
          <MiniDag nodes={goal.nodes} />
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={answer} onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Your answer resumes the goal…"
          className="flex-1 bg-bg border border-line rounded-md px-3 py-2 outline-none focus:border-dim"
        />
        <Button variant="primary" disabled={busy} onClick={send}>{busy ? "…" : "Answer"}</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}
