// src/agents/resolve.ts — ONE resolution path for every agent seam (org-model spec §7).
// resolveAgent(name, origin, ctx) → { options, ceiling, labels }: capability-union
// allowedTools, the single MCP builder registry, guard AND-composition, model tiering
// by kind, gate action ceiling, and data-scope labels. Seams keep only run-scoped
// concerns (mail widening, attachments, StructuredOutput, denial observer LAST).
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { Config } from "../config.js";
import type { AgentDef, AgentKind, LoadedRegistry, LoadedDepartment } from "./registry/loader.js";
import { AIOS_PACK_BARE, fqPackTool, type CapabilityDef } from "./registry/capabilities.js";
import { roleQueryOptions } from "./runner.js";
import { withEffectiveTools } from "./permissions.js";
import { guardOptions, NAMED_GUARDS, type GuardConfig, type NamedGuard, type ToolCheck } from "./guards/index.js";
import { codeGuard, advisoryGuard } from "../code/guard.js";
import { memoContextForDomain } from "../memory/memos.js";
import { buildPackServer } from "../packs/server.js";
import { buildCodeServer } from "../code/exec.js";
import { buildMoneyServer } from "../money/server.js";
import { buildResearchServer } from "../research/server.js";
import { buildLifeopsServer } from "../lifeops/server.js";
import { buildLedgerServer } from "../finance/server.js";
import { buildCloudflareServer } from "../senses/cloudflare/server.js";
import { HALALO_DIR } from "./registry/extras.js";
import type { MoneyServerDeps } from "../money/server.js";

const AIOS_PACK = "aios-pack";

export interface ResolveCtx {
  cwd?: string;
  /** Sandbox workspace for code-sandbox capabilities (same shape the pack resolver took). */
  workspace?: { taskDir: string; mode: "build" | "analyze" };
  /** Goal-attempt dedupe key (goalId:node:attempt#) — gate proposals carry it. */
  idempotencyKey?: string;
  /** Caller model override — loses to a per-agent manifest `model:`, wins over kind tiering. */
  model?: string;
}

export interface ResolvedAgent {
  canonical: string;
  kind: AgentKind;
  def: AgentDef;
  /** SDK options: prompt + capability-union allowedTools (DB-effective) + static MCP servers
   *  + guards + tiered model. NO denial observer — seams wrap that LAST (widen-before-wrap). */
  options: Options;
  /** Gate action ceiling = union of capability actions. */
  ceiling: string[];
  /** Data-scope labels = union of capability labels (Information-Flow Policy consumes). */
  labels: string[];
}

export type ResolveAgentFn = (
  name: string,
  origin: { channel: string; chatId: string },
  ctx?: ResolveCtx,
) => ResolvedAgent | undefined;

export interface ResolveAgentDeps {
  registry: LoadedRegistry;
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  config: Config;
  /** Money-server categorizer (index.ts builds the real one; tests may stub). */
  categorize?: MoneyServerDeps["categorize"];
}

type ServerCtx = {
  deps: ResolveAgentDeps;
  origin: { channel: string; chatId: string };
  dept: LoadedDepartment;
  ceiling: string[];
  idempotencyKey?: string;
};

/** THE single MCP builder registry (spec §3): every static server an agent can carry.
 *  Run-scoped servers (aios-mail, aios_attachments, the moderator's aios server) stay at
 *  their seams — they need per-run context a static resolve cannot have. */
const SERVER_BUILDERS: Record<string, (c: ServerCtx) => Record<string, unknown>> = {
  [AIOS_PACK]: (c) => ({
    [AIOS_PACK]: buildPackServer({
      store: c.deps.store, vault: c.deps.vault, gate: c.deps.gate,
      actions: c.ceiling, memoDomain: c.dept.memoDomain,
      origin: c.origin, idempotencyKey: c.idempotencyKey,
    }),
  }),
  money: (c) => ({ money: buildMoneyServer({ store: c.deps.store, categorize: c.deps.categorize! }) }),
  research: (c) => ({ research: buildResearchServer({ store: c.deps.store }) }),
  lifeops: (c) => ({ lifeops: buildLifeopsServer({ store: c.deps.store }) }),
  ledger: (c) => ({
    ledger: buildLedgerServer(
      { store: c.deps.store, vault: c.deps.vault, gate: c.deps.gate, origin: c.origin },
      { company: c.deps.config.financeCompany, members: c.deps.config.financeMembers },
    ),
  }),
  cloudflare: () => ({ halalo_analytics: buildCloudflareServer() }),
};

/** AND-compose named guards: for a tool with several checks, the first deny wins;
 *  fallback is deny if ANY guard declares it. */
function combineGuards(guards: NamedGuard[]): NamedGuard {
  if (guards.length === 1) return guards[0];
  const keys = new Set(guards.flatMap((g) => Object.keys(g.checks)));
  const checks: Record<string, ToolCheck> = {};
  for (const k of keys) {
    const fns = guards.map((g) => g.checks[k]).filter(Boolean) as ToolCheck[];
    checks[k] = (input) => {
      for (const f of fns) {
        const v = f(input);
        if (!v.ok) return v;
      }
      return { ok: true as const };
    };
  }
  return { checks, fallback: guards.some((g) => g.fallback === "deny") ? "deny" : undefined };
}

function tierModel(kind: AgentKind, config: Config): string | undefined {
  if (kind === "coordinator" || kind === "lead") return config.moderatorModel;
  if (kind === "critic") return config.criticModel;
  return config.specialistModel;
}

export function makeResolveAgent(deps: ResolveAgentDeps): ResolveAgentFn {
  const guardCfg: GuardConfig = {
    halaloDir: HALALO_DIR,
    vaultPath: deps.config.vaultPath,
    vaultSubdir: deps.config.vaultSubdir,
  };

  return (name, origin, ctx = {}) => {
    const canonical = deps.registry.agentOf.get(name.toLowerCase());
    if (!canonical) return undefined;
    const def = deps.registry.agents.get(canonical);
    if (!def) return undefined;
    const dept = deps.registry.departments.get(def.department);
    if (!dept) return undefined;

    const caps: CapabilityDef[] = def.capabilities.map((c) => {
      const capDef = deps.registry.capabilities.get(c);
      if (!capDef) throw new Error(`capability "${c}" vanished for agent ${canonical} (boot validated — registry mutated?)`);
      return capDef;
    });

    const allowedTools = [...new Set(caps.flatMap((c) => c.tools).map(fqPackTool))];
    const ceiling = [...new Set(caps.flatMap((c) => c.actions))];
    const labels = [...new Set(caps.flatMap((c) => c.labels))];
    const sandbox = caps.some((c) => c.sandbox);

    // Dept context block — same construction the pack resolver used (mission + gated memo).
    const includeMemo = !(dept.privateMemo && def.manifest.visibility !== "private");
    const memo = includeMemo ? memoContextForDomain(deps.store, deps.vault, dept.memoDomain) : "";
    const contextBlock = [`## Pillar: ${dept.department}`, dept.mission.trim(), memo]
      .filter(Boolean).join("\n\n");

    // Static MCP servers from capabilities. Shim era: bare aios-pack tools without an explicit
    // aios-pack capability still get the scoped server (the legacy path always attached it).
    const serverCtx: ServerCtx = { deps, origin, dept, ceiling, idempotencyKey: ctx.idempotencyKey };
    const serverNames = new Set(caps.map((c) => c.server).filter(Boolean) as string[]);
    if (caps.some((c) => c.tools.some((t) => AIOS_PACK_BARE.includes(t)))) serverNames.add(AIOS_PACK);
    let mcpServers: Record<string, unknown> = {};
    for (const s of serverNames) {
      if (s === "code") continue; // workspace-scoped — built in the sandbox branch below
      const builder = SERVER_BUILDERS[s];
      if (!builder) throw new Error(`unknown MCP server "${s}" for agent ${canonical} — add it to SERVER_BUILDERS`);
      mcpServers = { ...mcpServers, ...builder(serverCtx) };
    }

    const model = def.role.model ?? ctx.model ?? tierModel(def.kind, deps.config);

    // Base options via the existing role kernel (persona/context-files/skills/extras-guards),
    // then override with the capability-derived surface.
    const base = roleQueryOptions(def.role, { cwd: ctx.cwd ?? deps.config.projectsRoot, model });
    let options: Options = {
      ...base,
      systemPrompt: `${base.systemPrompt}\n\n${contextBlock}`,
      allowedTools,
      mcpServers: { ...(base.mcpServers ?? {}), ...(mcpServers as Options["mcpServers"]) },
    };

    // Capability guards (AND-composed). Shim era: an agent whose extras already installed
    // toolChecks (via roleQueryOptions above) keeps those; capability guards apply only when
    // extras carry none — the two sources are the same guards until the extras entries are
    // deleted in the cleanup task, so this avoids double-wrapping.
    const capGuards = caps.filter((c) => c.guard).map((c) => NAMED_GUARDS[c.guard!](guardCfg));
    if (!def.role.toolChecks && capGuards.length > 0) {
      const g = combineGuards(capGuards);
      const wired = guardOptions(g.checks, g.fallback ?? "allow");
      options = { ...options, canUseTool: wired.canUseTool, hooks: { ...(options.hooks ?? {}), ...(wired.hooks ?? {}) } };
    }

    // Sandbox confinement — byte-identical to the pack resolver's branch.
    if (sandbox) {
      if (ctx.workspace) {
        options.mcpServers = { ...(options.mcpServers ?? {}), code: buildCodeServer(ctx.workspace) as never };
        options.permissionMode = "default";
        delete (options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions;
        const g = guardOptions(codeGuard(ctx.workspace.taskDir, ctx.workspace.mode), "deny");
        options.canUseTool = g.canUseTool;
        options.hooks = { ...(options.hooks ?? {}), ...(g.hooks ?? {}) };
      } else {
        options.permissionMode = "default";
        delete (options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions;
        const g = guardOptions(advisoryGuard(), "deny");
        options.canUseTool = g.canUseTool;
        options.hooks = { ...(options.hooks ?? {}), ...(g.hooks ?? {}) };
      }
    }

    // DB grant/revoke overrides LAST among widenings (fail-closed) — observer stays at the seams.
    options = withEffectiveTools(options, canonical, deps.store);

    return { canonical, kind: def.kind, def, options, ceiling, labels };
  };
}
