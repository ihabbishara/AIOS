import { z } from "zod";

export const packSchema = z.object({
  pillar: z.string().min(1),
  persona: z.string().min(1),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  tools: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
}).transform((p) => ({ ...p, vaultSection: p.vaultSection ?? p.pillar }));

export type Pack = z.infer<typeof packSchema>;

export interface PackRegistry {
  packs: Map<string, Pack>;
  pillarOf: Map<string, string>;
  roleOf: Map<string, string>;
}
