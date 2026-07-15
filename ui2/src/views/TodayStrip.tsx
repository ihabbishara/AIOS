// ui2/src/views/TodayStrip.tsx — one line above the queue: date · brief link · budget today.
import { api, type StoredEvent } from "../api.js";
import { useLiveQuery } from "../hooks.js";
import { T } from "../lib/topics.js";
import { usd } from "../lib/format.js";

export function TodayStrip({ events, onOpenBrief }: {
  events: StoredEvent[];
  onOpenBrief: (threadId: string) => void;
}) {
  const { data: budget } = useLiveQuery(() => api.budget(), events, T.budget);
  const { data: mine } = useLiveQuery(() => api.mailMine(), events, T.agentMail);
  const brief = mine?.threads.find((t) => t.lastFrom === "hermes");
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="flex items-center gap-3 px-3 h-9 border-b border-line text-[11px] text-dim shrink-0">
      <span className="text-fg">{date}</span>
      {brief && (
        <button className="hover:text-fg underline underline-offset-2" onClick={() => onOpenBrief(brief.threadId)}>
          latest brief
        </button>
      )}
      {budget && <span className="ml-auto font-mono">{usd(budget.spentCents)} today{budget.capCents != null ? ` / ${usd(budget.capCents)}` : ""}</span>}
    </div>
  );
}
