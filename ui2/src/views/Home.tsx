// ui2/src/views/Home.tsx — placeholder; the triage cockpit lands in Task 5.
import type { AttentionItem, StoredEvent } from "../api.js";
import { Empty } from "../components/ui.js";

export function Home(_: {
  events: StoredEvent[];
  attention: AttentionItem[] | undefined;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  return <div className="p-6"><Empty>Nothing needs you.</Empty></div>;
}
