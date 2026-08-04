// ui2/src/views/canvas/Goal.tsx — failed/paused goal: error, failed node in the thread, cost, actions.
import { useState } from "react";
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Button, SectionLabel, Empty } from "../../components/ui.js";
import { TwoStepButton } from "../../components/TwoStepButton.js";
import { statusClock, CLOCK_TEXT } from "../../lib/goal-clock.js";
import { usd } from "../../lib/format.js";
import { Thread } from "../Thread.js";

export function GoalCanvas({ item, events, onAct, onOpenChat, onDone }: {
  item: AttentionItem; events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
  onDone: () => void;
}) {
  const { data: goal } = useLiveQuery(() => api.goal(item.ref.goalId), events, T.goals, [item.ref.goalId]);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState("");
  if (!goal) return <Empty>Loading…</Empty>;
  const failedNode = goal.nodes.find((n) => n.status === "failed");
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  const canReopen = item.actions.includes("reopen");
  const reopen = async () => {
    setError("");
    try {
      await api.goalAction(item.ref.goalId, "reopen", guidance.trim() ? { guidance } : undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Goal</SectionLabel>
        <span className={`font-mono text-[11px] uppercase ${CLOCK_TEXT[statusClock(goal.status)]}`}>{goal.status}</span>
        <span className="text-[11px] text-dim ml-auto">{usd(cost)} so far</span>
      </div>
      <div className="text-[15px] text-strong">{goal.title}</div>
      {goal.error && <div className="panel !border-err/40 p-3 text-err text-[12px] whitespace-pre-wrap">{goal.error}</div>}
      <Thread nodes={goal.nodes} failedKey={failedNode?.key} />
      {canReopen && (
        <textarea
          value={guidance} onChange={(e) => setGuidance(e.target.value)} rows={3}
          placeholder="Guidance for the reopen (optional — failed nodes restart fresh with this in their brief)"
          className="w-full bg-raised rounded p-2 text-[13px]"
        />
      )}
      <div className="flex gap-2 flex-wrap">
        <Button variant="primary" onClick={() => navigate(`goals/${goal.slug}`)}>Open in Goals</Button>
        {canReopen && <Button variant="primary" onClick={() => void reopen()}>Reopen</Button>}
        {item.actions.includes("resume") && <Button onClick={() => onAct(item, "resume")}>Resume</Button>}
        <TwoStepButton label="Abandon" onConfirm={() => onAct(item, "abandon")} />
        <Button onClick={() => onOpenChat(goal.lead, `About goal "${goal.title}" (${goal.status}): `)}>Discuss ⌘J</Button>
      </div>
      {error && <div className="text-[12px] text-err">{error}</div>}
    </div>
  );
}
