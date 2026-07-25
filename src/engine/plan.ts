// src/engine/plan.ts — graph validation (fail-closed) + lead planner (Task 7).
import type { LoadedRegistry, AgentDef } from "../agents/registry/loader.js";
import { isPrivateOrigin } from "../agents/direct.js";
import { isUnder, isSecretPath } from "../code/paths.js";
import { toNewTaskNodes, type GraphNodeSpec } from "./compile.js";
import { resolve } from "node:path";
import type { Store } from "../store/db.js";
import type { SpecialistRunFn } from "../agents/runner.js";

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
  // Cross-department graphs (spec 2026-07-07): any shared agent from any department may be
  // planned in; the per-agent private-origin rule below is the only cross-dept gate.
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
    // No self-approval (verification-hardening §5): a loop's producer may not be its own
    // critic; a verify's runner may not be its own fixer. Compare canonically — aliases
    // must not smuggle the same agent into both seats. Cross-department planning means a
    // foreign critic is always available, so this never makes a plan unsatisfiable.
    if ((n.type === "loop" || n.type === "verify") && n.critic) {
      const canon = (name: string) => ctx.registry.agentOf.get(name) ?? name;
      if (canon(n.agent) === canon(n.critic)) {
        return n.type === "loop"
          ? { ok: false, error: `node ${n.key}: producer and critic must be different agents (no self-approval) — pick a critic from another team` }
          : { ok: false, error: `node ${n.key}: runner and fixer must be different agents (no self-verification) — pick a fixer from another team` };
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

export const GRAPH_SCHEMA = {
  type: "object",
  required: ["summary", "needsWorkspace", "nodes"],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    needsWorkspace: { enum: ["greenfield", "worktree", "analyze", "none"] },
    projectDir: { type: "string" },
    nodes: {
      type: "array", minItems: 1, maxItems: 12,
      items: {
        type: "object",
        required: ["key", "type", "agent", "brief", "deps"],
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          type: { enum: ["run", "loop", "verify"] },
          agent: { type: "string" },
          critic: { type: "string" },
          brief: { type: "string" },
          deps: { type: "array", items: { type: "string" } },
          maxRounds: { type: "integer", minimum: 1, maximum: 5 },
        },
      },
    },
  },
} as const;

export const PATCH_SCHEMA = {
  type: "object",
  required: ["ops"],
  additionalProperties: false,
  properties: {
    ops: {
      type: "array", minItems: 1, maxItems: 6,
      items: {
        type: "object",
        required: ["op"],
        additionalProperties: true,
        properties: { op: { enum: ["replace", "add", "abandon"] } },
      },
    },
  },
} as const;

export function renderPlanPreview(title: string, summary: string, nodes: GraphNodeSpec[]): string {
  const lines = nodes.map((n) => {
    const pair = n.critic ? `${n.agent} ⇄ ${n.critic}` : n.agent;
    const after = n.deps.length ? ` — after: ${n.deps.join(", ")}` : "";
    return `- ${n.key} (${n.type}) — ${pair}${after}`;
  });
  return `📋 Plan for "${title}" — ${summary}\n${lines.join("\n")}\nStarting now. /pause or /abandon <goal> anytime.`;
}

interface RawPlan {
  summary: string;
  needsWorkspace: "greenfield" | "worktree" | "analyze" | "none";
  projectDir?: string;
  nodes: Array<{ key: string; type: "run" | "loop" | "verify"; agent: string; critic?: string; brief: string; deps: string[]; maxRounds?: number }>;
}

const firstSentence = (s: string) => s.trim().split(/(?<=\.)\s/)[0];

function agentLine(a: AgentDef): string {
  const schema = a.manifest.outputSchema ? ` [outputSchema: ${a.manifest.outputSchema}]` : "";
  return `- ${a.manifest.name} — ${a.manifest.title} — ${firstSentence(a.manifest.charter)}${schema}`;
}

/** Own department's full roster first, then foreign agents grouped under Borrowable headers.
 *  Foreign private-visibility agents are listed only for private-chat origins — roster
 *  filtering is UX; validateGraph remains the enforcement layer (fail-closed on races). */
export function rosterBlock(
  registry: LoadedRegistry, department: string,
  origin: { channel: string; chatId: string }, primaryChat?: { channel: string; chatId: string },
): string {
  const all = [...registry.agents.values()];
  const own = all.filter((a) => a.department === department).map(agentLine).join("\n");
  const privateOk = isPrivateOrigin(primaryChat, origin.channel, origin.chatId);
  const foreign: string[] = [];
  for (const [name, d] of [...registry.departments].sort(([a], [b]) => a.localeCompare(b))) {
    if (name === department) continue;
    const members = all.filter((a) =>
      a.department === name && (privateOk || a.manifest.visibility !== "private"));
    if (!members.length) continue;
    foreign.push(`## Borrowable — ${name} (${firstSentence(d.mission)})\n${members.map(agentLine).join("\n")}`);
  }
  return [own, ...foreign].filter(Boolean).join("\n\n");
}

export function planningBrief(dept: string, title: string, request: string, roster: string, retryError?: string, doctrine?: string): string {
  return [
    `You are the ${dept} department lead. Decompose the goal below into a task graph.`,
    `# Goal: ${title}\n${request}`,
    `# Your agents\n${roster}`,
    `# Node types
- run: one agent, one brief, one artifact.
- loop: producer + critic rounds; the critic MUST be an agent tagged [outputSchema: verdict].
- verify: runner + fixer rounds; the runner MUST be an agent tagged [outputSchema: test-report]; put the fixer in "critic".
# Rules
- 1-12 nodes. Keys: lowercase-kebab. "deps" lists node keys that must finish first; independent nodes run in parallel.
- Only agents from the roster above.
- Prefer your own department's agents; borrow agents listed under other departments only when the task genuinely needs them.
- Each brief must stand alone: the agent sees the goal request + prior artifacts of its deps, nothing else.
- needsWorkspace: "worktree" (edit an existing repo safely) | "analyze" (read-only repo) | "greenfield" (new scratch dir) | "none". projectDir required for worktree/analyze.
- Documentation, summaries, or analysis that only READ code need needsWorkspace "none" — agents Read/Grep repos directly. Only request worktree/analyze when the task must run commands or git inside the repo.`,
    doctrine ? `# Department doctrine\n${doctrine.trim()}` : "",
    retryError ? `# Your previous plan was INVALID — fix this and return a corrected plan\n${retryError}` : "",
  ].filter(Boolean).join("\n\n");
}

export interface PlannerDeps {
  registry: LoadedRegistry;
  store: Store;
  run: SpecialistRunFn;
  primaryChat?: { channel: string; chatId: string };
  projectsRoot: string;
  /** Daemon's own source root — a workspace source under it is allowed (served as a clone
   *  by allocateWorkspace). Every other secret path is still refused. */
  selfRoot?: string;
  postPreview: (origin: { channel: string; chatId: string }, text: string) => Promise<void>;
  log?: (l: string) => void;
}

export function makePlanner(deps: PlannerDeps): import("./goals.js").Planner {
  // resolveAgent (inside deps.run) resolves the lead's dept context/tools/model by kind.
  const runLead = async (lead: string, brief: string, origin: { channel: string; chatId: string }, schema: Record<string, unknown>) =>
    deps.run(lead, brief, {
      cwd: deps.projectsRoot, origin,
      outputSchema: schema,
    });

  const validateOrExplain = (nodes: RawPlan["nodes"], department: string, origin: { channel: string; chatId: string }) => {
    const specs: GraphNodeSpec[] = nodes.map((n) => ({
      key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps, maxRounds: n.maxRounds,
    }));
    const v = validateGraph(specs, { registry: deps.registry, department, origin, primaryChat: deps.primaryChat });
    return { specs, v };
  };

  /** Plan-time workspace validation — mirrors the exec-time guards (workspace.ts) so a bad
   *  projectDir fails DURING planning (retryable, corrected by the lead) instead of at
   *  workspace setup, which used to leave a dead failed-goal card. */
  const workspaceError = (raw: RawPlan): string | undefined => {
    if (raw.needsWorkspace !== "worktree" && raw.needsWorkspace !== "analyze") return undefined;
    // isUnder is separator-boundary-safe (a plain startsWith would admit /x/projectsevil).
    if (!raw.projectDir || !isUnder(raw.projectDir, deps.projectsRoot)) {
      return `needsWorkspace ${raw.needsWorkspace} requires projectDir under ${deps.projectsRoot}`;
    }
    // The daemon's own root is denylisted so nothing reads the LIVE repo, but it is a valid
    // work source: allocateWorkspace serves it as a secret-free clone (spec 2026-07-25).
    const isSelf = Boolean(deps.selfRoot && isUnder(raw.projectDir, deps.selfRoot));
    if (!isSelf && isSecretPath(raw.projectDir)) {
      return `projectDir ${raw.projectDir} is on the secret denylist and can never be a workspace source — if the goal only reads code or writes a document, use needsWorkspace "none" (agents Read/Grep repos directly); otherwise pick a different directory`;
    }
    return undefined;
  };

  const buildValidatedPlan = async (params: { department: string; title: string; request: string; channel: string; chatId: string }) => {
    const dept = deps.registry.departments.get(params.department);
    if (!dept?.lead) throw new Error(`unknown department or no lead: "${params.department}" — use hand_off or run_playbook instead`);
    const origin = { channel: params.channel, chatId: params.chatId };
    const roster = rosterBlock(deps.registry, params.department, origin, deps.primaryChat);
    let raw: RawPlan | undefined;
    let error = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await runLead(dept.lead, planningBrief(params.department, params.title, params.request, roster, attempt === 2 ? error : undefined, dept.plannerDoctrine), origin, GRAPH_SCHEMA);
      const candidate = res.structured as RawPlan | undefined;
      if (!candidate?.nodes) { error = "no structured plan returned"; continue; }
      const { v } = validateOrExplain(candidate.nodes, params.department, origin);
      if (!v.ok) { error = v.error; continue; }
      const wsErr = workspaceError(candidate);
      if (wsErr) { error = wsErr; continue; }
      raw = candidate;
      break;
    }
    if (!raw) throw new Error(`planning failed: ${error}`);
    const { specs } = validateOrExplain(raw.nodes, params.department, origin);
    return { dept, lead: dept.lead, raw, specs, origin };
  };

  /** Returns the resolved workspace dir (undefined for greenfield/none). The loop above
   *  already validated — this re-check is a fail-closed backstop. */
  const resolveWorkspaceDir = (raw: RawPlan): string | undefined => {
    if (raw.needsWorkspace !== "worktree" && raw.needsWorkspace !== "analyze") return undefined;
    const err = workspaceError(raw);
    if (err) throw new Error(`planning failed: ${err}`);
    return resolve(raw.projectDir!);
  };

  return {
    async plan(engine, params) {
      const { lead, raw, specs, origin } = await buildValidatedPlan(params);
      const projectDir = resolveWorkspaceDir(raw);
      await deps.postPreview(origin, renderPlanPreview(params.title, raw.summary, specs));
      return engine.startPlannedGoal({
        title: params.title, request: params.request, department: params.department, lead,
        origin, summary: raw.summary, nodes: toNewTaskNodes(specs), projectDir, needsWorkspace: raw.needsWorkspace,
      });
    },

    async planFromMail(engine, params, mail) {
      // Mail-origin: no chat preview (no human waiting). Workspace only for user-sent mail to
      // engineering (spec 2026-07-07-workspace-mail-goals) — agent mail keeps the hard
      // force-none wall (§2/§5); the engine strips independently as defense in depth.
      const { lead, raw, specs, origin } = await buildValidatedPlan(params);
      const workspaceEligible = mail.from_agent === "user" && params.department === "engineering";
      return engine.startPlannedGoal({
        title: params.title, request: params.request, department: params.department, lead,
        origin, summary: raw.summary, nodes: toNewTaskNodes(specs),
        projectDir: workspaceEligible ? resolveWorkspaceDir(raw) : undefined,
        needsWorkspace: workspaceEligible ? raw.needsWorkspace : "none",
        spawnedByMail: mail.id, chainDepth: mail.chain_depth,
      });
    },

    async replan(goal, failed, errorMsg) {
      const origin = { channel: goal.origin_channel, chatId: goal.origin_chat_id };
      const nodes = deps.store.listNodes(goal.id);
      const state = nodes.map((n) => ({
        key: n.node_key, type: n.type, agent: n.agent, critic: n.critic ?? undefined,
        status: n.status, deps: JSON.parse(n.depends_on) as string[], error: n.error ?? undefined,
      }));
      const roster = rosterBlock(deps.registry, goal.department, origin, deps.primaryChat);
      const brief = [
        `You are the ${goal.department} lead. A node in your plan failed — patch the plan.`,
        `# Goal: ${goal.title}\n${goal.request}`,
        `# Current graph\n${JSON.stringify(state, null, 2)}`,
        `# Failed node: ${failed.node_key}\n${errorMsg}`,
        `# Your agents\n${roster}`,
        `# Patch ops (return {"ops":[...]})
- {"op":"replace","key":"<node_key>","node":{key,type,agent,critic?,brief,deps,maxRounds?}} — swap the failed node (key may stay the same).
- {"op":"add","nodes":[{...}]} — add new nodes (done nodes are immutable).
- {"op":"abandon","reason":"..."} — when the goal cannot be salvaged.
Same rules as planning: roster agents only, verdict/test-report critics, ≤12 total nodes, no cycles.`,
      ].join("\n\n");

      const res = await runLead(goal.lead, brief, origin, PATCH_SCHEMA);
      const patch = res.structured as { ops: Array<Record<string, unknown>> } | undefined;
      if (!patch?.ops?.length) throw new Error("lead returned no patch ops");

      // Build the would-be graph, validate whole, then persist.
      type RawNode = RawPlan["nodes"][number];
      const current = new Map(state.map((s) => [s.key, { key: s.key, type: s.type, agent: s.agent, critic: s.critic, brief: nodes.find((n) => n.node_key === s.key)!.brief, deps: s.deps } as RawNode]));
      const replaces: RawNode[] = [];
      const adds: RawNode[] = [];
      const doneKeys = new Set(nodes.filter((n) => n.status === "done").map((n) => n.node_key));
      for (const op of patch.ops) {
        if (op.op === "abandon") throw new Error(`lead recommends abandoning: ${String(op.reason ?? "no reason")}`);
        if (op.op === "replace") {
          if (doneKeys.has(String(op.key))) throw new Error(`patch invalid: node "${String(op.key)}" is done — done nodes are immutable`);
          const n = op.node as RawNode; current.set(String(op.key), n); replaces.push(n);
        }
        if (op.op === "add") { for (const n of (op.nodes as RawNode[]) ?? []) { current.set(n.key, n); adds.push(n); } }
      }
      const { v } = validateOrExplain([...current.values()], goal.department, origin);
      if (!v.ok) throw new Error(`patch invalid: ${v.error}`);

      // Journaled engine: the planner validates and RETURNS the patch; the engine records
      // it as replan.recorded (journal is the truth — no direct row writes here).
      const toGraph = (n: RawNode): GraphNodeSpec =>
        ({ key: n.key, type: n.type, agent: n.agent, critic: n.critic, brief: n.brief, deps: n.deps, maxRounds: n.maxRounds });
      await deps.postPreview(origin, `♻️ Re-planned "${goal.title}" after ${failed.node_key} failed:\n${renderPlanPreview(goal.title, "patched plan", [...current.values()].map(toGraph))}`);
      return { replaced: replaces.map(toGraph), added: adds.map(toGraph) };
    },
  };
}
