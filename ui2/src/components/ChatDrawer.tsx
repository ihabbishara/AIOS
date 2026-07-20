// ui2/src/components/ChatDrawer.tsx — ⌘J bottom sheet; stays mounted so the log/draft survive.
import type { StateInfo, StoredEvent } from "../api.js";
import { Sheet } from "./Sheet.js";
import { Chat } from "./Chat.js";

export function ChatDrawer({ open, onClose, state, events, target, setTarget, seed }: {
  open: boolean; onClose: () => void; state: StateInfo | undefined; events: StoredEvent[];
  target: string; setTarget: (t: string) => void; seed?: string;
}) {
  return (
    <Sheet open={open} onClose={onClose}>
      <div className="flex items-center gap-3 px-4 h-10 border-b border-line shrink-0">
        <span className="label">Chat · {target}</span>
        {target === "hermes" && <span className="text-[10.5px] text-dim">chief of staff — routes work to the right specialist</span>}
        <span className="label ml-auto hidden md:inline">⌘J or esc closes</span>
        <button onClick={onClose} aria-label="Close chat" className="text-dim hover:text-strong text-[14px] leading-none px-1">✕</button>
      </div>
      <div className="flex-1 min-h-0 p-4">
        <Chat state={state} events={events} target={target} setTarget={setTarget} seed={seed} />
      </div>
    </Sheet>
  );
}
