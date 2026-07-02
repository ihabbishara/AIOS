import { z } from "zod";

export const packSchema = z.object({
  pillar: z.string().min(1),
  persona: z.string().min(1),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  /** Optional pack-specific MCP tool-server name (resolved from the builder registry). */
  toolServer: z.string().optional(),
  /** Additional pack-specific tool-server names (merged with singular toolServer, back-compat). */
  toolServers: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
  /** When true, the pack requires a jailed workspace + confinement (the code pack). */
  sandbox: z.boolean().default(false),
  /** When true, the memo block is injected only for private-visibility agents (see departmentSchema). */
  privateMemo: z.boolean().default(false),
}).transform((p) => ({ ...p, vaultSection: p.vaultSection ?? p.pillar }));

export type Pack = z.infer<typeof packSchema>;

export interface PackRegistry {
  packs: Map<string, Pack>;
  pillarOf: Map<string, string>;
  roleOf: Map<string, string>;
}
