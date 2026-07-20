// ui2/src/views/TodayStrip.tsx — one line above the queue: date · brief · budget today.
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
  // neo is the coordinator; "hermes" matches pre-rename brief threads still in the store.
  const brief = mine?.threads.find((t) => t.lastFrom === "neo" || t.lastFrom === "hermes");
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  return (
    <div className="flex items-center gap-3 px-3 h-10 border-b border-line text-[11px] text-dim shrink-0">
      <span className="text-strong text-[12px]">{date}</span>
      {brief && (
        <button
          onClick={() => onOpenBrief(brief.threadId)}
          className="border border-line rounded-md px-2 py-0.5 text-[10.5px] text-fg hover:text-strong hover:border-dim transition-colors"
        >
          Today's brief →
        </button>
      )}
      {budget && <span className="ml-auto font-mono">{usd(budget.spentCents)} today{budget.capCents != null ? ` / ${usd(budget.capCents)}` : ""}</span>}
    </div>
  );
}
