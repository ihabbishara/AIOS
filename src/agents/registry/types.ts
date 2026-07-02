import { z } from "zod";

/** One agent manifest (agents/<dept>/<name>.yaml). Compiled to RoleDef at load. */
export const agentSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lowercase kebab name"),
  title: z.string().min(1),
  department: z.string().min(1),
  charter: z.string().min(1),
  persona: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).default([]),
  guards: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().default(25),
  permissionMode: z.enum(["dontAsk", "bypassPermissions", "default"]).default("dontAsk"),
  visibility: z.enum(["shared", "private"]).default("shared"),
  outputSchema: z.enum(["verdict", "test-report"]).optional(),
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
});
export type AgentManifest = z.infer<typeof agentSchema>;

/** Department manifest (agents/<dept>/department.yaml) — pack.yaml evolved; tools live on agents. */
export const departmentSchema = z.object({
  department: z.string().min(1),
  mission: z.string().min(1),
  lead: z.string().optional(),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  toolServer: z.string().optional(),
  /** Additional pack-specific MCP tool-server names (merged with singular toolServer, back-compat). */
  toolServers: z.array(z.string()).default([]),
  /** Dept-level tool names prepended to the toolsUnion (e.g. recall/vault_read that are safe dept-wide). */
  tools: z.array(z.string()).default([]),
  actions: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
  sandbox: z.boolean().default(false),
}).transform((d) => ({ ...d, vaultSection: d.vaultSection ?? d.department }));
export type DepartmentManifest = z.infer<typeof departmentSchema>;
