// ui2/src/views/Mail.tsx — placeholder; the Mail section lands in Task 9.
import type { StoredEvent } from "../api.js";
import type { Route } from "../lib/router.js";
import { Empty } from "../components/ui.js";

export function Mail(_: { events: StoredEvent[]; route: Route }) {
  return <div className="p-6"><Empty>Mail — Task 9</Empty></div>;
}
