// ui2/src/lib/field.ts — the org as a body (spec 2026-08-02 §6).
// Note what is NOT a parameter here: the tide level. Position cannot depend on
// how busy the org is, so this function is structurally unable to move a dot
// when work starts. That is the "a dot never moves" rule, enforced by the
// signature rather than by a convention someone has to remember.
import type { OrgAgentCard, OrgDepartmentView } from "../api.js";

export type DotState = "now" | "waiting" | "rest";

/** Tailwind classes, not hex — raw colour outside tokens.css fails the doctrine test. */
export const DOT_TOKEN: Record<DotState, string> = {
  now: "bg-now",
  waiting: "bg-accent",
  rest: "bg-rest",
};

export function stateOf(card: OrgAgentCard): DotState {
  if (card.status === "working") return "now";
  if (card.status === "waiting") return "waiting";
  return "rest";
}

export interface Cluster {
  department: string;
  dots: Array<{
    name: string;
    title: string;
    state: DotState;
    currentTask: string | null;
    col: number;
    row: number;
  }>;
}

/** Agents per cluster row before wrapping. */
const PER_ROW = 4;

export function fieldLayout(depts: OrgDepartmentView[]): Cluster[] {
  // Sorted, not input-ordered: /api/org iterates a Map, and a registry reload
  // could otherwise silently reshuffle the whole field under the user.
  return [...depts]
    .sort((a, b) => a.department.localeCompare(b.department))
    .map((d) => ({
      department: d.department,
      dots: [...d.agents]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((a, i) => ({
          name: a.name,
          title: a.title,
          state: stateOf(a),
          currentTask: a.currentTask,
          col: i % PER_ROW,
          row: Math.floor(i / PER_ROW),
        })),
    }));
}

export function workingCount(depts: OrgDepartmentView[]): number {
  return depts.reduce((n, d) => n + d.agents.filter((a) => a.status === "working").length, 0);
}
