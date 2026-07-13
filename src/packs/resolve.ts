import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { ToolCheck } from "../agents/guards/halalo-readonly.js";
import type { Pack } from "./types.js";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { buildPackServer } from "./server.js";
import { memoContextForDomain } from "../memory/memos.js";
import { codeGuard, advisoryGuard } from "../code/guard.js";
import { buildCodeServer } from "../code/exec.js";

/** Manifest `tools` entries that map to the scoped pack MCP server (everything else is built-in). */
export const MCP_TOOL_NAMES = ["recall", "vault_read", "vault_write", "propose_action"];
const SERVER_NAME = "aios-pack";

export interface ResolvedPack {
  pillar: string;
  contextBlock: string;
  tools: string[];
  mcpServers: Record<string, unknown>;
  confinement?: { permissionMode: "default"; guard: Record<string, ToolCheck>; fallback: "deny" };
}

/** Builds a pack-specific MCP server instance for a resolve. */
export type PackToolServerBuilder = (deps: {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  origin: { channel: string; chatId: string };
}) => unknown;

export interface ResolveDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  origin: { channel: string; chatId: string };
  /** Registry of pack-specific tool-server builders, keyed by manifest `toolServer`. */
  toolServers?: Record<string, PackToolServerBuilder>;
  workspace?: { taskDir: string; mode: "build" | "analyze" };
  /** Visibility of the agent this pack is being resolved for (byAgent path). Undefined on the
   *  playbook path. Used with pack.privateMemo to gate the memo block. */
  agentVisibility?: "shared" | "private";
  /** Goal-attempt dedupe key (goalId:node:attempt#) — gate proposals from this pack carry it. */
  idempotencyKey?: string;
}

export function resolvePack(pack: Pack, deps: ResolveDeps): ResolvedPack {
  // A privateMemo department injects the memo block ONLY for private agents. A shared agent
  // (or the playbook path, where visibility is unknown) gets mission/persona but no memo.
  const includeMemo = !(pack.privateMemo && deps.agentVisibility !== "private");
  const memo = includeMemo ? memoContextForDomain(deps.store, deps.vault, pack.memoDomain) : "";
  const contextBlock = [
    `## Pillar: ${pack.pillar}`,
    pack.persona.trim(),
    memo,
  ].filter(Boolean).join("\n\n");

  const tools = pack.tools.map((t) => (MCP_TOOL_NAMES.includes(t) ? `mcp__${SERVER_NAME}__${t}` : t));

  const server = buildPackServer({
    store: deps.store,
    vault: deps.vault,
    gate: deps.gate,
    actions: pack.actions,
    memoDomain: pack.memoDomain,
    origin: deps.origin,
    idempotencyKey: deps.idempotencyKey,
  });

  const mcpServers: Record<string, unknown> = { [SERVER_NAME]: server };
  // Merge both singular toolServer and plural toolServers (back-compat).
  const allToolServers = [
    ...(pack.toolServer ? [pack.toolServer] : []),
    ...(pack.toolServers ?? []),
  ];
  for (const tsName of allToolServers) {
    const builder = deps.toolServers?.[tsName];
    if (builder) {
      mcpServers[tsName] = builder({ store: deps.store, vault: deps.vault, gate: deps.gate, origin: deps.origin });
    }
    // unknown toolServer → fail-soft: omit it; the pack still loads with the shared server.
  }

  let confinement: ResolvedPack["confinement"];
  if (pack.sandbox) {
    if (deps.workspace) {
      mcpServers.code = buildCodeServer(deps.workspace);
      confinement = { permissionMode: "default", guard: codeGuard(deps.workspace.taskDir, deps.workspace.mode), fallback: "deny" };
    } else {
      confinement = { permissionMode: "default", guard: advisoryGuard(), fallback: "deny" };
    }
  }

  return { pillar: pack.pillar, contextBlock, tools, mcpServers, confinement };
}

/**
 * Registry-driven resolver: playbook → owning department; agent (byAgent) → its department.
 * Department pack shape is built from department + toolsUnion the same way resolvePack builds
 * from a Pack manifest — so pillar, persona, memo, tools, toolServer, sandbox, actions all wire up.
 */
export function makeResolveDeptFor(
  reg: LoadedRegistry,
  deps: { store: Store; vault: VaultWriter; gate: ActionGate; toolServers?: Record<string, PackToolServerBuilder> },
) {
  return (
    key: string,
    origin: { channel: string; chatId: string },
    byAgent = false,
    workspace?: { taskDir: string; mode: "build" | "analyze" },
    idempotencyKey?: string,
  ): ResolvedPack | undefined => {
    const agent = byAgent ? reg.agents.get(reg.agentOf.get(key) ?? key) : undefined;
    const deptName = byAgent ? agent?.department : reg.ownerOfPlaybook.get(key);
    if (!deptName) return undefined;
    const d = reg.departments.get(deptName);
    if (!d) return undefined;
    return resolvePack(
      {
        pillar: d.department,
        persona: d.mission,
        memoDomain: d.memoDomain,
        vaultSection: d.vaultSection,
        toolServer: d.toolServer,
        toolServers: d.toolServers,
        tools: d.toolsUnion,
        actions: d.actions,
        roles: [],
        playbooks: d.playbooks,
        sandbox: d.sandbox,
        privateMemo: d.privateMemo,
      },
      {
        store: deps.store, vault: deps.vault, gate: deps.gate, origin,
        toolServers: deps.toolServers, workspace,
        agentVisibility: agent?.manifest.visibility,
        idempotencyKey,
      },
    );
  };
}

