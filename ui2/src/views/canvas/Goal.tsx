// ui2/src/views/canvas/Goal.tsx — failed/paused goal: error, failed node in the mini DAG, cost, actions.
import { api, type AttentionItem, type StoredEvent } from "../../api.js";
import { useLiveQuery } from "../../hooks.js";
import { T } from "../../lib/topics.js";
import { navigate } from "../../lib/router.js";
import { Button, SectionLabel, Tag, Empty, toneOfStatus } from "../../components/ui.js";
import { TwoStepButton } from "../../components/TwoStepButton.js";
import { usd } from "../../lib/format.js";
import { MiniDag } from "../MiniDag.js";

export function GoalCanvas({ item, events, onAct, onOpenChat }: {
  item: AttentionItem; events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
}) {
  const { data: goal } = useLiveQuery(() => api.goal(item.ref.goalId), events, T.goals, [item.ref.goalId]);
  if (!goal) return <Empty>Loading…</Empty>;
  const failedNode = goal.nodes.find((n) => n.status === "failed");
  const cost = goal.nodes.reduce((s, n) => s + n.costCents, 0);
  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <SectionLabel>Goal</SectionLabel>
        <Tag tone={toneOfStatus(goal.status)}>{goal.status}</Tag>
        <span className="text-[11px] text-dim ml-auto">{usd(cost)} so far</span>
      </div>
      <div className="text-[15px] text-strong">{goal.title}</div>
      {goal.error && <div className="panel !border-err/40 p-3 text-err text-[12px] whitespace-pre-wrap">{goal.error}</div>}
      <MiniDag nodes={goal.nodes} failedKey={failedNode?.key} />
      <div className="flex gap-2 flex-wrap">
        <Button variant="primary" onClick={() => navigate(`goals/${goal.slug}`)}>Open in Goals</Button>
        {item.actions.includes("resume") && <Button onClick={() => onAct(item, "resume")}>Resume</Button>}
        <TwoStepButton label="Abandon" onConfirm={() => onAct(item, "abandon")} />
        <Button onClick={() => onOpenChat(goal.lead, `About goal "${goal.title}" (${goal.status}): `)}>Discuss ⌘J</Button>
      </div>
    </div>
  );
}
