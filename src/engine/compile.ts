// src/engine/compile.ts — playbook YAML (SOP format, untouched on disk) → graph nodes.
import type { Playbook, Stage } from "./playbook.js";
import type { NewTaskNode } from "../store/db.js";

export interface GraphNodeSpec {
  key: string;
  type: "run" | "loop" | "verify";
  agent: string;
  critic?: string;
  brief: string;
  deps: string[];
  maxRounds?: number;
}

const DEFAULT_ROUNDS: Record<GraphNodeSpec["type"], number> = { run: 1, loop: 3, verify: 2 };

function stageToNode(stage: Stage, deps: string[]): GraphNodeSpec {
  switch (stage.type) {
    case "single":
      return { key: stage.id, type: "run", agent: stage.role, brief: stage.brief ?? "", deps, maxRounds: 1 };
    case "loop":
      return { key: stage.id, type: "loop", agent: stage.producer, critic: stage.critic, brief: stage.brief ?? "", deps, maxRounds: stage.maxRounds };
    case "verify":
      return { key: stage.id, type: "verify", agent: stage.runner, critic: stage.fixer, brief: stage.brief ?? "", deps, maxRounds: stage.maxRounds };
  }
}

/** Linear chain: stage N depends on stage N-1 — the degenerate DAG with identical semantics. */
export function compilePlaybook(pb: Playbook): GraphNodeSpec[] {
  const out: GraphNodeSpec[] = [];
  for (const [i, stage] of pb.stages.entries()) {
    out.push(stageToNode(stage, i === 0 ? [] : [pb.stages[i - 1].id]));
  }
  return out;
}

export function toNewTaskNodes(nodes: GraphNodeSpec[]): NewTaskNode[] {
  return nodes.map((n) => ({
    node_key: n.key, type: n.type, agent: n.agent, critic: n.critic ?? null,
    brief: n.brief, depends_on: n.deps, max_rounds: n.maxRounds ?? DEFAULT_ROUNDS[n.type],
  }));
}
