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
    const design = pb.stages.find((s) => s.id === "design");
    expect(design).toMatchObject({ type: "loop", producer: "kai", critic: "nadia", maxRounds: 3 });
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
