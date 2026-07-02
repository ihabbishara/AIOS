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

/** Ownership-based clamp: a pack tool survives only if the role actually owns it. Applies to
 *  aios-pack tools too — they are dept-scoped + gate-ceilinged, but a dept-mate must NOT
 *  inherit one it doesn't own (e.g. shared salim must never get faris's recall/vault_read via
 *  the finance union). aios-pack tools are owned by the BARE manifest name (recall/vault_read/…)
 *  which resolvePack maps to the fq mcp__aios-pack__ name; the fq name is also accepted. Every
 *  other tool (built-in or other mcp__ server) requires exact ownership. */
export function clampTools(roleTools: string[] | undefined, packTools: string[]): string[] {
  const owned = new Set(roleTools ?? []);
  const AIOS_PACK = "mcp__aios-pack__";
  return packTools.filter((t) => {
    if (t.startsWith(AIOS_PACK)) return owned.has(t.slice(AIOS_PACK.length)) || owned.has(t);
    return owned.has(t);
  });
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

/**
 * Pure option assembly for a specialist run — the capability kernel shared by both the
 * pipeline runner (hand_off path) and direct chats (@mention path).
 * Exported so tests can pin capability parity: if either path drops pack or skips
 * withEffectiveTools, a parity test using this function will catch the divergence.
 */
export function specialistOptions(
  role: RoleDef,
  canonical: string,
  opts: RunOptions,
  store: Store,
): Options {
  const baseOptions = roleQueryOptions(role, { cwd: opts.cwd, model: opts.model });
  const withPack = opts.pack ? packRunOptions(baseOptions, opts.pack) : baseOptions;
  return withEffectiveTools(withPack, canonical, store);
}

export function makeRunSpecialist(deps: { store: Store; bus: EventBus; registry: LoadedRegistry }): SpecialistRunFn {
  return async (roleName, brief, opts) => {
    const canonical = deps.registry.agentOf.get(roleName) ?? roleName;
    const role = deps.registry.agents.get(canonical)?.role;
    if (!role) throw new Error(`Unknown agent: ${roleName}`);

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const merged = specialistOptions(role, canonical, opts, deps.store);
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
