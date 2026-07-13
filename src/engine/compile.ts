// src/engine/compile.ts — playbook YAML (SOP format, untouched on disk) → graph nodes.
import type { Playbook, Stage } from "./playbook.js";
import type { NewTaskNode } from "../store/db.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";

/** All role names a stage references, across every stage shape. */
export function stageRoles(stage: Stage): string[] {
  switch (stage.type) {
    case "single": return [stage.role];
    case "loop": return [stage.producer, stage.critic];
    case "verify": return [stage.runner, stage.fixer];
  }
}

/** A playbook is "unsandboxed-write" iff it is packless (no owning department) AND a stage uses a
 *  bypassPermissions role — the in-place coding path that must be gated. */
export function isUnsandboxedWrite(pb: Playbook, ownerOf?: Map<string, string>, registry?: LoadedRegistry): boolean {
  if (!registry) throw new Error("isUnsandboxedWrite: registry is required (fail-closed)");
  if (ownerOf?.get(pb.name)) return false;
  return pb.stages.some((st) => stageRoles(st).some((r) => {
    const agentName = registry.agentOf.get(r) ?? r;
    return registry.agents.get(agentName)?.role.permissionMode === "bypassPermissions";
  }));
}

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
