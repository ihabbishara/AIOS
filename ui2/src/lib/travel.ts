// ui2/src/lib/travel.ts — one memo crossing the field, spec §5 `travel`.
//
// Pure on purpose: picking WHICH crossing to draw is a question about the event
// stream, and the arc between two dots is a question about geometry. Neither needs
// the DOM, so neither is trapped inside Field.tsx where it could not be asserted on.
import type { StoredEvent } from "../api.js";

export interface Travel { id: number; from: string; to: string }

export interface Point { x: number; y: number }

/** How far the arc bows off the straight line, as a fraction of its length. Enough
 *  to read as a path rather than a laser; small enough not to leave the field. */
const BOW = 0.18;

/** The newest agent-to-agent memo after `afterId`, or null.
 *
 *  Newest, not oldest: a burst of mail during a busy second should show the latest
 *  crossing rather than queue up a backlog the org has already moved past. Mail to
 *  or from the user is excluded by construction — the user is not a dot on the field,
 *  so there is no endpoint to draw to. */
export function pickTravel(
  events: StoredEvent[],
  afterId: number,
  onField: ReadonlySet<string>,
): Travel | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.id <= afterId || e.event.type !== "mail.sent") continue;
    const from = String(e.event.from ?? "");
    const to = String(e.event.to ?? "");
    if (from === "user" || to === "user") continue;
    if (!onField.has(from) || !onField.has(to)) continue;
    return { id: e.id, from, to };
  }
  return null;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** An SVG path from a to b, bowed perpendicular to the line between them. Deterministic:
 *  the same two dots always produce the same arc, so a re-measure mid-flight does not
 *  make the mote jump onto a different route. */
export function travelPath(a: Point, b: Point): string {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  // Bow direction follows the vector's sign rather than a random pick — two agents
  // trading memos then trace the same wire in both directions.
  const mx = round((a.x + b.x) / 2 - dy * BOW);
  const my = round((a.y + b.y) / 2 + dx * BOW);
  return `M ${round(a.x)} ${round(a.y)} Q ${mx} ${my} ${round(b.x)} ${round(b.y)}`;
}
