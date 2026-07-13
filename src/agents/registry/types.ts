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
  skills: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().default(25),
  permissionMode: z.enum(["dontAsk", "bypassPermissions", "default"]).default("dontAsk"),
  visibility: z.enum(["shared", "private"]).default("shared"),
  outputSchema: z.enum(["verdict", "test-report"]).optional(),
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
  /** Org role — declared explicitly; workers are the default. Exactly one coordinator at boot. */
  kind: z.enum(["coordinator", "lead", "worker", "critic"]).default("worker"),
  /** Capability names (agents/_capabilities.yaml), merged with the department's defaults. */
  capabilities: z.array(z.string()).default([]),
});
export type AgentManifest = z.infer<typeof agentSchema>;

/** Department manifest (agents/<dept>/department.yaml) — pack.yaml evolved; tools live on agents. */
export const departmentSchema = z.object({
  department: z.string().min(1),
  mission: z.string().min(1),
  lead: z.string().optional(),
  memoDomain: z.string().min(1),
  vaultSection: z.string().optional(),
  /** Capability defaults inherited by every member agent (org-model spec §4). */
  capabilities: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
  sandbox: z.boolean().default(false),
  /** When true, the department's memo block is injected ONLY for private-visibility agents.
   *  Shared members (e.g. the group-facing bookkeeper) get mission/persona but NOT the memo,
   *  which can carry private money preferences. */
  privateMemo: z.boolean().default(false),
}).transform((d) => ({ ...d, vaultSection: d.vaultSection ?? d.department }));
export type DepartmentManifest = z.infer<typeof departmentSchema>;
