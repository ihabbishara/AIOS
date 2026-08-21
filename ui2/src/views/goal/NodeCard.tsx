// ui2/src/views/goal/NodeCard.tsx — one node, drawn the same way at every
// fidelity. The map changes how cards are ARRANGED; it never changes what a
// card says, so a single-node goal and a lane in a diamond stay comparable.
import { elapsed } from "../../lib/thread.js";
import { statusClock, CLOCK_TOKEN, CLOCK_TEXT, isMuted } from "../../lib/goal-clock.js";
import { usd } from "../../lib/format.js";
import { Avatar, Tag } from "../../components/ui.js";
import type { GoalNodeView } from "../../api.js";

/** Text, not icons: a glyph inherits the row's colour and size for free, and
 *  the doctrine keeps SVG for geometry that could not be a character. */
const GLYPH: Record<string, string> = { run: "▸", loop: "⟳", verify: "✓" };

export function NodeCard({ node, blocked, selected, onSelect, live, fixed }: {
  node: GoalNodeView;
  /** This is the goal's failed node, whatever its own status says. */
  blocked?: boolean;
  selected?: boolean;
  onSelect?: (key: string) => void;
  /** The event stream is connected, so "running" is running right now. */
  live?: boolean;
  /** Lane geometry: the dag needs every card the same box. */
  fixed?: boolean;
}) {
  const clock = statusClock(node.status);
  const tone = blocked || clock === "blocked" ? "blocked" : clock;

  return (
    <div
      data-testid="map-node"
      data-key={node.key}
      // Only a card that actually does something gets button semantics — the
      // same rule Thread follows, so a read-only map adds nothing to the tab order.
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(node.key) : undefined}
      onKeyDown={onSelect ? (e) => e.key === "Enter" && onSelect(node.key) : undefined}
      className={`border rounded-md px-2.5 py-2 bg-surface overflow-hidden ${
        fixed ? "w-[176px] h-[78px]" : ""
      } ${selected ? "border-dim bg-raised" : "border-line"} ${
        onSelect ? "cursor-pointer hover:border-dim" : ""
      } ${isMuted(node.status) ? "opacity-55" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <span
          data-testid="map-dot"
          className={`size-1.5 rounded-full shrink-0 ${CLOCK_TOKEN[tone]} ${
            clock === "now" && live ? "breath" : ""
          }`}
        />
        <span className="text-[12px] text-strong truncate">{node.key}</span>
        <span className="text-dim text-[11px] shrink-0 ml-auto" title={node.type}>
          {GLYPH[node.type] ?? GLYPH.run}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-1">
        <Avatar name={node.agent} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className={`font-mono text-[9.5px] uppercase truncate ${CLOCK_TEXT[tone]}`}>{node.status}</span>
            {node.critic && <Tag tone="dim">{node.critic}</Tag>}
          </div>
          <div className="flex items-baseline gap-1.5 font-mono text-[9.5px] text-dim">
            <span>{elapsed(node.startedAt, node.finishedAt)}</span>
            <span>{usd(node.costCents)}</span>
          </div>
        </div>
      </div>
      {node.error && (
        // First line only. The inspector holds the whole trace; a card that grew
        // to fit a stack trace would break the grid the edges are drawn on.
        <div className="text-[9.5px] text-err truncate mt-0.5">{node.error.split("\n")[0]}</div>
      )}
    </div>
  );
}
