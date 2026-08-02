// ui2/src/views/home/QueueSheet.tsx — the existing Queue, relocated (spec §7).
// Nothing about triage is redesigned here: same component, same grouping, same
// keyboard model. This file is a container and an Escape handler.
import { useEffect } from "react";
import { Queue } from "../Queue.js";
import { Canvas } from "../canvas/index.js";
import type { QueueGroup } from "../../lib/queue.js";
import type { AttentionItem, StoredEvent } from "../../api.js";

export function QueueSheet({
  open, onClose, groups, selected, onSelect, onAct, rowErrors, busy, events, onOpenChat,
}: {
  open: boolean;
  onClose: () => void;
  groups: QueueGroup[];
  selected: AttentionItem | null;
  /** Widened past Queue's own `(i: AttentionItem) => void` so the detail panes can
   *  clear the selection without a cast. Queue's narrower prop is assignable. */
  onSelect: (i: AttentionItem | null) => void;
  onAct: (i: AttentionItem, verb: string) => void;
  rowErrors: Record<string, string>;
  busy: Set<string>;
  events: StoredEvent[];
  onOpenChat: (target: string, seed?: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface/95 backdrop-blur-sm">
      <div className="flex items-center gap-3 px-5 h-11 border-b border-line shrink-0">
        <span className="label">Needs you</span>
        <button onClick={onClose} className="ml-auto text-[11px] text-dim hover:text-fg">
          close <kbd>esc</kbd>
        </button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="w-[360px] shrink-0 border-r border-line py-2 hidden md:flex flex-col">
          <Queue groups={groups} selected={selected} onSelect={onSelect} onAct={onAct} rowErrors={rowErrors} busy={busy} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 hidden md:block">
          <Canvas item={selected} events={events} onAct={onAct} onOpenChat={onOpenChat} onDone={() => onSelect(null)} />
        </div>
        {/* Phone: queue-first, a selection pushes full-screen detail — as the old Home did. */}
        <div className="flex-1 min-h-0 md:hidden flex flex-col py-2">
          {selected ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-3">
              <button onClick={() => onSelect(null)} className="label hover:text-fg mb-3">← queue</button>
              <Canvas item={selected} events={events} onAct={onAct} onOpenChat={onOpenChat} onDone={() => onSelect(null)} />
            </div>
          ) : (
            <Queue groups={groups} selected={selected} onSelect={onSelect} onAct={onAct} rowErrors={rowErrors} busy={busy} />
          )}
        </div>
      </div>
    </div>
  );
}
