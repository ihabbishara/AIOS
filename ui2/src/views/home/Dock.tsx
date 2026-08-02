// ui2/src/views/home/Dock.tsx — the queue's standing representative (spec §7).
// Fill (not hue) marks severity 1, because every attention row is amber now.
import { dockChips } from "../../lib/dock.js";
import type { AttentionItem } from "../../api.js";

export function Dock({ items, onOpenQueue }: {
  items: AttentionItem[];
  onOpenQueue: () => void;
}) {
  const { chips, overflow } = dockChips(items);
  return (
    <div className="flex items-center gap-2.5 px-5 py-2.5 border-t border-line bg-surface overflow-x-auto">
      <span className="label shrink-0">Needs you</span>
      {chips.length === 0 && <span className="text-[11px] text-dim shrink-0">Nothing. Inbox clear.</span>}
      {chips.map((c) => (
        <button
          key={c.id}
          onClick={onOpenQueue}
          className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] border transition-colors ${
            c.fill
              ? "bg-accent border-accent text-black font-medium"
              : "border-line text-fg hover:border-dim"
          }`}
        >
          {c.title}
        </button>
      ))}
      {overflow > 0 && (
        <button onClick={onOpenQueue} className="shrink-0 text-[11px] text-dim hover:text-fg">
          +{overflow}
        </button>
      )}
      <span className="ml-auto shrink-0 text-[10px] text-dim">
        <kbd>q</kbd> queue
      </span>
    </div>
  );
}
