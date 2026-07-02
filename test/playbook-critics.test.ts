import { describe, it, expect } from "vitest";
import { testRegistry } from "./fixtures/registry.js";

// Structural invariant: the pipeline executor only APPROVES a loop when the critic returns a
// structured verdict, and only ACCEPTS a verify stage when the runner returns a structured
// test-report. So every loop critic and every verify runner MUST resolve to a compiled role
// that carries an outputSchema — otherwise the stage can never approve/accept and loops burn
// their full maxRounds. This guards against wiring a schema-less role (e.g. nadia) into a loop.
describe("every loop critic + verify runner is verdict-schema'd", () => {
  const reg = testRegistry();
  const outputSchemaOf = (name: string): unknown => {
    const canonical = reg.agentOf.get(name) ?? name;
    return reg.agents.get(canonical)?.role.outputSchema;
  };

  for (const [pbName, pb] of reg.playbooks) {
    for (const stage of pb.stages) {
      if (stage.type === "loop") {
        it(`${pbName}/${stage.id}: loop critic "${stage.critic}" has an outputSchema`, () => {
          expect(outputSchemaOf(stage.critic), `${stage.critic} must be verdict-schema'd`).toBeTruthy();
        });
      }
      if (stage.type === "verify") {
        it(`${pbName}/${stage.id}: verify runner "${stage.runner}" has an outputSchema`, () => {
          expect(outputSchemaOf(stage.runner), `${stage.runner} must be verdict-schema'd`).toBeTruthy();
        });
      }
    }
  }
});
