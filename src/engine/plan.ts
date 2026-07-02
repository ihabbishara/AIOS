// src/engine/plan.ts — graph validation (fail-closed) + lead planner (Task 7).
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { isPrivateOrigin } from "../agents/direct.js";
import type { GraphNodeSpec } from "./compile.js";

export const MAX_NODES = 12;
const KEY_RE = /^[a-z][a-z0-9-]*$/;

export interface ValidateCtx {
  registry: LoadedRegistry;
  department: string;
  origin: { channel: string; chatId: string };
  primaryChat?: { channel: string; chatId: string };
}
export type ValidateResult = { ok: true; order: string[] } | { ok: false; error: string };

function agentCheck(name: string, role: "agent" | "critic", node: string, ctx: ValidateCtx): string | null {
  const canonical = ctx.registry.agentOf.get(name);
  const def = canonical ? ctx.registry.agents.get(canonical) : undefined;
  if (!def) return `node ${node}: unknown ${role} "${name}"`;
  if (def.department !== ctx.department) {
    return `node ${node}: ${role} "${name}" is in ${def.department}, not ${ctx.department} (single-department goals)`;
  }
  if (def.manifest.visibility === "private" &&
      !isPrivateOrigin(ctx.primaryChat, ctx.origin.channel, ctx.origin.chatId)) {
    return `node ${node}: ${role} "${name}" is private and this goal's origin is not the private chat`;
  }
  return null;
}

function schemaOf(name: string, reg: LoadedRegistry): string | undefined {
  const canonical = reg.agentOf.get(name);
  return canonical ? reg.agents.get(canonical)?.manifest.outputSchema : undefined;
}

export function validateGraph(nodes: GraphNodeSpec[], ctx: ValidateCtx): ValidateResult {
  if (nodes.length === 0) return { ok: false, error: "plan has no nodes" };
  if (nodes.length > MAX_NODES) return { ok: false, error: `plan has ${nodes.length} nodes (cap ${MAX_NODES})` };

  const keys = new Set<string>();
  for (const n of nodes) {
    if (!KEY_RE.test(n.key)) return { ok: false, error: `bad node key "${n.key}" (lowercase kebab)` };
    if (keys.has(n.key)) return { ok: false, error: `duplicate node key "${n.key}"` };
    keys.add(n.key);
  }
  for (const n of nodes) {
    for (const d of n.deps) if (!keys.has(d)) return { ok: false, error: `node ${n.key}: unknown dep "${d}"` };
    const err = agentCheck(n.agent, "agent", n.key, ctx) ??
      (n.critic ? agentCheck(n.critic, "critic", n.key, ctx) : null);
    if (err) return { ok: false, error: err };
    if (n.type === "loop") {
      if (!n.critic) return { ok: false, error: `node ${n.key}: loop needs a critic` };
      if (schemaOf(n.critic, ctx.registry) !== "verdict") {
        return { ok: false, error: `node ${n.key}: loop critic "${n.critic}" must carry outputSchema: verdict` };
      }
    }
    if (n.type === "verify") {
      if (!n.critic) return { ok: false, error: `node ${n.key}: verify needs a fixer (critic field)` };
      if (schemaOf(n.agent, ctx.registry) !== "test-report") {
        return { ok: false, error: `node ${n.key}: verify runner "${n.agent}" must carry outputSchema: test-report` };
      }
    }
  }

  // Kahn topological sort — preserves input order among ready nodes for stable output.
  const indegree = new Map(nodes.map((n) => [n.key, n.deps.length]));
  const order: string[] = [];
  while (order.length < nodes.length) {
    const next = nodes.find((n) => indegree.get(n.key) === 0 && !order.includes(n.key));
    if (!next) return { ok: false, error: "plan has a dependency cycle" };
    order.push(next.key);
    for (const n of nodes) if (n.deps.includes(next.key)) indegree.set(n.key, indegree.get(n.key)! - 1);
  }
  return { ok: true, order };
}
