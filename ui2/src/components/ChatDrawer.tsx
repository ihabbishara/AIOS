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
      <div className="flex items-center px-4 h-10 border-b border-line shrink-0">
        <span className="label">Chat · {target}</span>
        <span className="label ml-auto">⌘J to close</span>
      </div>
      <div className="flex-1 min-h-0 p-4">
        <Chat state={state} events={events} target={target} setTarget={setTarget} seed={seed} />
      </div>
    </Sheet>
  );
}
