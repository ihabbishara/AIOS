// ui2/test/field.test.ts — the field is a body, not a chart. Its one law is that
// a dot never moves: an agent lighting up must appear where it already was.
import { describe, it, expect } from "vitest";
import { stateOf, fieldLayout, workingCount } from "../src/lib/field.js";
import type { OrgDepartmentView, OrgAgentCard } from "../src/api.js";

const card = (name: string, status: OrgAgentCard["status"]): OrgAgentCard => ({
  name, title: "T", charter: "c", visibility: "shared", guarded: false,
  status, currentTask: status === "working" ? "node 3/5" : null, costTodayUsd: 0,
});

const org = (statuses: Array<OrgAgentCard["status"]>): OrgDepartmentView[] => [
  { department: "engineering", mission: "m", lead: "atlas",
    agents: [card("atlas", statuses[0]), card("vulcan", statuses[1]), card("odin", statuses[2])] },
  { department: "research", mission: "m", lead: "clio",
    agents: [card("clio", statuses[3]), card("janus", statuses[4])] },
];

describe("stateOf", () => {
  it("maps the three server statuses onto three dot states", () => {
    expect(stateOf(card("a", "working"))).toBe("now");
    expect(stateOf(card("a", "waiting"))).toBe("waiting");
    expect(stateOf(card("a", "idle"))).toBe("rest");
  });
});

describe("fieldLayout", () => {
  it("keeps every dot at the same coordinates when agents start working", () => {
    const quiet = fieldLayout(org(["idle", "idle", "idle", "idle", "idle"]));
    const busy = fieldLayout(org(["idle", "working", "idle", "working", "waiting"]));
    const coords = (cs: ReturnType<typeof fieldLayout>) =>
      cs.flatMap((c) => c.dots.map((d) => `${c.department}/${d.name}@${d.col},${d.row}`));
    expect(coords(busy)).toEqual(coords(quiet));
  });

  it("orders departments and agents deterministically regardless of input order", () => {
    const a = fieldLayout(org(["idle", "idle", "idle", "idle", "idle"]));
    const b = fieldLayout([...org(["idle", "idle", "idle", "idle", "idle"])].reverse());
    expect(a.map((c) => c.department)).toEqual(b.map((c) => c.department));
    expect(a[0].dots.map((d) => d.name)).toEqual(b[0].dots.map((d) => d.name));
  });

  it("wraps a cluster onto a second row past four agents", () => {
    const wide: OrgDepartmentView[] = [{
      department: "engineering", mission: "m", lead: "atlas",
      agents: ["a", "b", "c", "d", "e", "f"].map((n) => card(n, "idle")),
    }];
    const dots = fieldLayout(wide)[0].dots;
    expect(dots.map((d) => d.row)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(dots.map((d) => d.col)).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it("carries currentTask through so the field can caption itself", () => {
    const busy = fieldLayout(org(["working", "idle", "idle", "idle", "idle"]));
    expect(busy[0].dots[0].currentTask).toBe("node 3/5");
  });
});

describe("workingCount", () => {
  it("counts only working — waiting is blocked on a human, not running", () => {
    expect(workingCount(org(["working", "waiting", "idle", "working", "idle"]))).toBe(2);
  });
});
