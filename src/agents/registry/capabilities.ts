// src/agents/registry/capabilities.ts — the Capability primitive (org-model spec §3).
// One struct owns what was smeared across pack manifests, dept manifests, and hardcoded wiring.
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const capabilitySchema = z.object({
  /** Name in the single MCP builder registry (src/agents/resolve.ts SERVER_BUILDERS). */
  server: z.string().optional(),
  tools: z.array(z.string()).default([]),
  /** Gate action-ceiling contribution (union across the agent's capabilities). */
  actions: z.array(z.string()).default([]),
  /** Named deterministic ToolChecks (guards/index.ts NAMED_GUARDS). Guards AND-compose. */
  guard: z.string().optional(),
  sandbox: z.boolean().default(false),
  /** Data-scope labels — consumed by the Information-Flow Policy spec. */
  labels: z.array(z.string()).default([]),
});

export type CapabilityDef = z.infer<typeof capabilitySchema>;

/** Manifest tool names that live on the scoped aios-pack server (bare → fq at resolve). */
export const AIOS_PACK_BARE = ["recall", "vault_read", "vault_write", "propose_action"];
export const fqPackTool = (t: string): string =>
  AIOS_PACK_BARE.includes(t) ? `mcp__aios-pack__${t}` : t;

export function loadCapabilities(path: string): Map<string, CapabilityDef> {
  const out = new Map<string, CapabilityDef>();
  if (!existsSync(path)) return out;
  const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  for (const [name, def] of Object.entries(raw ?? {})) {
    out.set(name, capabilitySchema.parse(def));
  }
  return out;
}
