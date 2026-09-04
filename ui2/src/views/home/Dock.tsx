// ui2/src/views/home/Dock.tsx — the queue's standing representative (spec §7).
// Fill (not hue) marks severity 1, because every attention row is amber now.
//
// The empty and non-empty states are deliberately NOT the same object. As one quiet strip in
// surface grey at the foot of a dark page, a waiting approval read as chrome and got missed for
// hours — and these are the rows that block an agent mid-job, so missing one stalls work rather
// than merely postponing a glance. With something in it the dock takes an accent rule and a
// tinted ground, and says how many. Empty, it goes back to being furniture: a bar that shouts
// when there is nothing to shout about teaches you to stop looking at it.
import { dockChips } from "../../lib/dock.js";
import type { AttentionItem } from "../../api.js";

export function Dock({ items, onOpenQueue }: {
  items: AttentionItem[];
  onOpenQueue: () => void;
}) {
  const { chips, overflow } = dockChips(items);
  const waiting = items.length;
  return (
    <div
      data-waiting={waiting}
      className={`flex items-center gap-2.5 px-5 overflow-x-auto ${
        waiting > 0
          ? "py-3 border-t-2 border-accent bg-accent/[0.08]"
          : "py-2.5 border-t border-line bg-surface"
      }`}
    >
      <span className={`label shrink-0 ${waiting > 0 ? "text-accent" : ""}`}>
        {waiting > 0 ? `Needs you · ${waiting}` : "Needs you"}
      </span>
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
