// ui2/src/views/System.tsx — placeholder; the System section lands in Task 10.
import type { StoredEvent } from "../api.js";
import type { Route } from "../lib/router.js";
import { Empty } from "../components/ui.js";

export function System(_: { events: StoredEvent[]; route: Route }) {
  return <div className="p-6"><Empty>System — Task 10</Empty></div>;
}
