import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RoleDef } from "./roles/index.js";
import { guardOptions } from "./guards/index.js";
import type { ResolvedPack } from "../packs/resolve.js";
import type { Store } from "../store/db.js";
import type { EventBus } from "../events.js";
import type { LoadedRegistry } from "./registry/loader.js";
import { withEffectiveTools, withDenialObserver } from "./permissions.js";

const SKILLS_PLUGIN_PATH =
  process.env.AIOS_SKILLS_PLUGIN ?? join(process.cwd(), "skills-plugin");

/** SDK options that load this role's skills from the aios-skills plugin. */
export function skillOptions(role: RoleDef): Partial<Options> {
  if (!role.skills?.length || !existsSync(SKILLS_PLUGIN_PATH)) return {};
  return {
    plugins: [{ type: "local", path: SKILLS_PLUGIN_PATH }],
    skills: role.skills.map((s) => `aios-skills:${s}`),
  };
}

/** System prompt = persona + injected context files (e.g. a project CLAUDE.md, read fresh each session). */
export function roleSystemPrompt(role: RoleDef): string {
  let prompt = role.systemPrompt;
  for (const file of role.contextFiles ?? []) {
    if (!existsSync(file)) continue;
    prompt += `\n\n# Project knowledge (${file})\n\n${readFileSync(file, "utf8")}`;
  }
  return prompt;
}

/**
 * Single source of truth for a role's SDK options — used by both the pipeline
 * runner and direct chats so security settings can never diverge.
 */
export function roleQueryOptions(role: RoleDef, opts: { cwd: string; model?: string }): Options {
  return {
    systemPrompt: roleSystemPrompt(role),
    allowedTools: role.allowedTools,
    permissionMode: role.permissionMode,
    ...(role.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    cwd: role.cwd ?? opts.cwd,
    maxTurns: role.maxTurns,
    settingSources: [],
    ...(opts.model ? { model: opts.model } : {}),
    ...skillOptions(role),
    ...(role.toolChecks ? guardOptions(role.toolChecks, role.toolCheckFallback ?? "allow") : {}),
  };
}

/** Built-ins narrow to the role's own allowlist; scoped aios-pack tools pass through
 *  (dept-scoped + gate-ceilinged); any OTHER mcp__ tool requires the role to own it —
 *  dept-mates must not inherit each other's tool servers (e.g. shared bookkeeper
 *  must never see the private cfo's money tools). */
export function clampTools(roleTools: string[] | undefined, packTools: string[]): string[] {
  const owned = new Set(roleTools ?? []);
  return packTools.filter((t) =>
    t.startsWith("mcp__aios-pack__") ? true
    : t.startsWith("mcp__") ? owned.has(t)
    : owned.has(t));
}

/** Apply a resolved pack to base SDK options: persona+memo appended to the prompt,
 *  tool allowlist clamped to role's built-ins + all pack MCP tools, scoped MCP server added.
 *  When pack.confinement is present, overrides permissionMode, drops allowDangerouslySkipPermissions,
 *  and installs the confinement guard (canUseTool + PreToolUse hook). Pure — returns a new object. */
export function packRunOptions(base: Options, pack: ResolvedPack): Options {
  const merged: Options = {
    ...base,
    systemPrompt: `${base.systemPrompt}\n\n${pack.contextBlock}`,
    allowedTools: clampTools(base.allowedTools, pack.tools),
    mcpServers: { ...(base.mcpServers ?? {}), ...(pack.mcpServers as Options["mcpServers"]) },
  };
  if (pack.confinement) {
    merged.permissionMode = pack.confinement.permissionMode;
    delete (merged as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions;
    const g = guardOptions(pack.confinement.guard, pack.confinement.fallback);
    merged.canUseTool = g.canUseTool;
    merged.hooks = { ...(merged.hooks ?? {}), ...(g.hooks ?? {}) };
  }
  return merged;
}

export interface SpecialistResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  numTurns: number;
}

export interface RunOptions {
  cwd: string;
  /** Extra directories the agent may touch (e.g. the target project). */
  additionalDirectories?: string[];
  model?: string;
  signal?: AbortSignal;
  /** When set, the owning pack's context (persona+memo), tool allowlist, and scoped MCP server. */
  pack?: ResolvedPack;
}

export type SpecialistRunFn = (
  role: string,
  brief: string,
  opts: RunOptions,
) => Promise<SpecialistResult>;

export function makeRunSpecialist(deps: { store: Store; bus: EventBus; registry: LoadedRegistry }): SpecialistRunFn {
  return async (roleName, brief, opts) => {
    const canonical = deps.registry.agentOf.get(roleName) ?? roleName;
    const role = deps.registry.agents.get(canonical)?.role;
    if (!role) throw new Error(`Unknown agent: ${roleName}`);

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const baseOptions = roleQueryOptions(role, { cwd: opts.cwd, model: opts.model });
      const withPack = opts.pack ? packRunOptions(baseOptions, opts.pack) : baseOptions;
      const merged = withEffectiveTools(withPack, canonical, deps.store);
      const observed = withDenialObserver(merged, canonical, (e) => deps.bus.emit({ type: "tool.denied", ...e }));
      const q = query({
        prompt: brief,
        options: {
          ...observed,
          additionalDirectories: opts.additionalDirectories,
          persistSession: false,
          abortController: abort,
          ...(role.outputSchema
            ? { outputFormat: { type: "json_schema" as const, schema: role.outputSchema } }
            : {}),
        },
      });

      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype === "success") {
            return {
              text: msg.result,
              structured: msg.structured_output,
              costUsd: msg.total_cost_usd,
              numTurns: msg.num_turns,
            };
          }
          throw new Error(
            `Specialist ${roleName} failed: ${msg.subtype}${"errors" in msg ? ` — ${msg.errors.join("; ")}` : ""}`,
          );
        }
      }
      throw new Error(`Specialist ${roleName} ended without a result message`);
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
}
