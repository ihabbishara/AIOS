import type { Store } from "../store/db.js";
import type { VaultWriter } from "../vault/writer.js";
import type { ActionGate } from "../kernel/gate.js";
import type { Pack } from "./types.js";
import { buildPackServer } from "./server.js";
import { memoContextForDomain } from "../memory/memos.js";

/** Manifest `tools` entries that map to the scoped pack MCP server (everything else is built-in). */
export const MCP_TOOL_NAMES = ["recall", "vault_read", "vault_write", "propose_action"];
const SERVER_NAME = "aios-pack";

export interface ResolvedPack {
  pillar: string;
  contextBlock: string;
  tools: string[];
  mcpServers: Record<string, unknown>;
}

export interface ResolveDeps {
  store: Store;
  vault: VaultWriter;
  gate: ActionGate;
  origin: { channel: string; chatId: string };
}

export function resolvePack(pack: Pack, deps: ResolveDeps): ResolvedPack {
  const memo = memoContextForDomain(deps.store, deps.vault, pack.memoDomain);
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
  });

  return { pillar: pack.pillar, contextBlock, tools, mcpServers: { [SERVER_NAME]: server } };
}

export interface PackResolverReg {
  packs: Map<string, Pack>;
  pillarOf: Map<string, string>;
  roleOf: Map<string, string>;
}

/** Closure over the pack registry + shared deps: routes a playbook (or role) to its ResolvedPack. */
export function makeResolvePackFor(
  reg: PackResolverReg,
  deps: { store: Store; vault: VaultWriter; gate: ActionGate },
) {
  return (key: string, origin: { channel: string; chatId: string }, byRole = false): ResolvedPack | undefined => {
    const pillar = byRole ? reg.roleOf.get(key) : reg.pillarOf.get(key);
    if (!pillar) return undefined;
    const pack = reg.packs.get(pillar);
    return pack ? resolvePack(pack, { store: deps.store, vault: deps.vault, gate: deps.gate, origin }) : undefined;
  };
}
