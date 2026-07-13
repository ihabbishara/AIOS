// src/engine/goals.ts — public façade of the journaled engine. Import paths stay stable;
// internals live in journal.ts / reduce.ts / decide.ts / project.ts / workers.ts / engine.ts.
export {
  GoalEngine, MAIL_PREFIX,
  type Planner, type ReplanPatch, type GoalOutcome, type GoalEngineDeps,
} from "./engine.js";
export {
  SessionLimitError, ancestorArtifacts, AbortRegistry, runAttempt,
  type Verdict, type TestReport, type WorkerDeps,
} from "./workers.js";
export { stageRoles, isUnsandboxedWrite } from "./compile.js";
