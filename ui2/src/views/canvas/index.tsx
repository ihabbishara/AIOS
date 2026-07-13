// ui2/src/views/canvas/index.tsx — placeholder; real renderers land in Task 6.
import type { AttentionItem, StoredEvent } from "../../api.js";
import { Empty } from "../../components/ui.js";

export function Canvas(_: {
  item: AttentionItem | null;
  events: StoredEvent[];
  onAct: (i: AttentionItem, verb: string) => void;
  onOpenChat: (t: string, s?: string) => void;
  onDone: () => void;
}) {
  return <Empty>Canvas — Task 6</Empty>;
}
