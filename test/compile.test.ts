// test/compile.test.ts
import { describe, it, expect } from "vitest";
import { compilePlaybook, toNewTaskNodes } from "../src/engine/compile.js";
import type { Playbook } from "../src/engine/playbook.js";

const PB: Playbook = {
  name: "code-build", description: "build", needsProjectDir: false,
  stages: [
    { type: "single", id: "research", role: "odin", brief: "research it" },
    { type: "loop", id: "implement", producer: "vulcan", critic: "minos", maxRounds: 3, brief: "build it" },
    { type: "verify", id: "test", runner: "argus", fixer: "vulcan", maxRounds: 2 },
  ],
};

describe("compilePlaybook", () => {
  it("maps stages to a linear node chain", () => {
    const nodes = compilePlaybook(PB);
    expect(nodes).toEqual([
      { key: "research", type: "run", agent: "odin", brief: "research it", deps: [], maxRounds: 1 },
      { key: "implement", type: "loop", agent: "vulcan", critic: "minos", brief: "build it", deps: ["research"], maxRounds: 3 },
      { key: "test", type: "verify", agent: "argus", critic: "vulcan", brief: "", deps: ["implement"], maxRounds: 2 },
    ]);
  });

  it("toNewTaskNodes fills defaults and serializes deps", () => {
    const rows = toNewTaskNodes([{ key: "a", type: "loop", agent: "vulcan", critic: "minos", brief: "x", deps: [] }]);
    expect(rows[0]).toEqual({ node_key: "a", type: "loop", agent: "vulcan", critic: "minos", brief: "x", depends_on: [], max_rounds: 3 });
  });
});
