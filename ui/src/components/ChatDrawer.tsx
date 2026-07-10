// ui/src/components/ChatDrawer.tsx — chat slides over the bottom so org/goal context stays visible.
import type { StateInfo, StoredEvent } from "../api.js";
import { Chat } from "../views/Chat.js";

export function ChatDrawer({ open, onClose, state, events, target, setTarget }: {
  open: boolean; onClose: () => void;
  state: StateInfo | undefined; events: StoredEvent[];
  target: string; setTarget: (t: string) => void;
}) {
  // Stays mounted (log/draft survive) — only visibility toggles.
  return (
    <div className={`fixed inset-x-0 bottom-0 z-40 border-t border-phosphor/40 bg-panel shadow-2xl transition-transform duration-200 ${open ? "translate-y-0" : "translate-y-full"}`}
      style={{ height: "min(480px, 70vh)" }}>
      <div className="flex items-center px-4 h-8 border-b border-line">
        <span className="label">Comms — {target}</span>
        <button onClick={onClose} className="ml-auto text-dim hover:text-fg text-[12px]">✕ close</button>
      </div>
      <div className="h-[calc(100%-2rem)] p-4">
        <Chat state={state} events={events} target={target} setTarget={setTarget} />
      </div>
    </div>
  );
}
