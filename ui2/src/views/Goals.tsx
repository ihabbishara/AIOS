// ui2/src/views/Goals.tsx — placeholder; the Goals section lands in Task 7.
import type { StoredEvent } from "../api.js";
import type { Route } from "../lib/router.js";
import { Empty } from "../components/ui.js";

export function Goals(_: {
  events: StoredEvent[];
  route: Route;
  onOpenChat: (target: string, seed?: string) => void;
}) {
  return <div className="p-6"><Empty>Goals — Task 7</Empty></div>;
}
