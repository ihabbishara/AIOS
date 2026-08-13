import { describe, it, expect } from "vitest";
import { loadPlaybooks, playbookSchema } from "../src/engine/playbook.js";
import { join } from "node:path";

describe("playbook loading", () => {
  it("loads all shipped playbooks", () => {
    const playbooks = loadPlaybooks(join(process.cwd(), "playbooks"));
    expect([...playbooks.keys()].sort()).toEqual([
      "code-inplace",
      "echo",
    ]);
  });

  it("code-inplace has the full pipeline and needs a project dir", () => {
    const playbooks = loadPlaybooks(join(process.cwd(), "playbooks"));
    const pb = playbooks.get("code-inplace")!;
    expect(pb.needsProjectDir).toBe(true);
    expect(pb.stages.map((s) => s.id)).toEqual(["research", "design", "implement", "test", "code-review"]);
    // Stages name slots, not agents: the same file has to bind on an org that has never heard of
    // athena. `prefer` is what keeps THIS install on the pair the playbook was written for —
    // test/playbook-bind.test.ts covers the resolution itself.
    const design = pb.stages.find((s) => s.id === "design");
    expect(design).toMatchObject({ type: "loop", producer: "architect", critic: "reviewer", maxRounds: 3 });
    expect(pb.bind?.architect?.prefer).toBe("athena");
    expect(pb.bind?.reviewer?.prefer).toBe("minos");
  });

  it("rejects invalid stage types", () => {
    expect(() =>
      playbookSchema.parse({
        name: "bad",
        description: "x",
        stages: [{ type: "nope", id: "a" }],
      }),
    ).toThrow();
  });

  it("rejects loop maxRounds above cap", () => {
    expect(() =>
      playbookSchema.parse({
        name: "bad",
        description: "x",
        stages: [{ type: "loop", id: "a", producer: "p", critic: "c", maxRounds: 99 }],
      }),
    ).toThrow();
  });
});
