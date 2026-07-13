// ui2/src/views/canvas/index.tsx — pick a renderer by AttentionItem.kind; idle = org pulse (spec §5).
import type { AttentionItem, StoredEvent } from "../../api.js";
import { ApprovalCanvas } from "./Approval.js";
import { ReviewCanvas } from "./Review.js";
import { AskCanvas } from "./Ask.js";
import { GoalCanvas } from "./Goal.js";
import { MailThreadCanvas } from "./MailThread.js";
import { OrgPulse } from "./OrgPulse.js";
import { Empty } from "../../components/ui.js";

export function Canvas({ item, events, onAct, onOpenChat, onDone }: {
  item: AttentionItem | null;
  events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
  onDone: () => void;
}) {
  if (!item) return <OrgPulse events={events} />;
  switch (item.kind) {
    case "approval": return <ApprovalCanvas item={item} events={events} onAct={onAct} onOpenChat={onOpenChat} />;
    case "review": return <ReviewCanvas item={item} events={events} onDone={onDone} />;
    case "ask": return <AskCanvas item={item} events={events} onDone={onDone} />;
    case "goal": return <GoalCanvas item={item} events={events} onAct={onAct} onOpenChat={onOpenChat} />;
    case "mail": return <MailThreadCanvas item={item} events={events} />;
    case "sense": return <Empty>{item.title} — {item.meta}. Fix from a terminal, then check System · Health.</Empty>;
  }
}
