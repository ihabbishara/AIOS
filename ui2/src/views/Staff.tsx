// ui2/src/views/Staff.tsx — placeholder; the Staff section lands in Task 8.
import type { StoredEvent } from "../api.js";
import type { Route } from "../lib/router.js";
import { Empty } from "../components/ui.js";

export function Staff(_: {
  events: StoredEvent[];
  route: Route;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  return <div className="p-6"><Empty>Staff — Task 8</Empty></div>;
}
