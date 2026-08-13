import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const singleStage = z.object({
  type: z.literal("single"),
  id: z.string(),
  role: z.string(),
  brief: z.string().optional(),
});

const loopStage = z.object({
  type: z.literal("loop"),
  id: z.string(),
  producer: z.string(),
  critic: z.string(),
  maxRounds: z.number().int().min(1).max(5).default(3),
  brief: z.string().optional(),
});

const verifyStage = z.object({
  type: z.literal("verify"),
  id: z.string(),
  runner: z.string(),
  fixer: z.string(),
  maxRounds: z.number().int().min(1).max(5).default(2),
  brief: z.string().optional(),
});

export const stageSchema = z.discriminatedUnion("type", [singleStage, loopStage, verifyStage]);

/** What an org needs to have in order to fill one slot. `prefer` names the agent to use when it
 *  exists — that keeps a playbook binding exactly as written on the install it was authored for,
 *  and lets `kind`/`capabilities` speak only for orgs that never had that name. `kind` is also a
 *  preference order: the earlier a kind is listed, the better a candidate of that kind. */
export const bindingSchema = z.object({
  prefer: z.string().optional(),
  kind: z.array(z.enum(["coordinator", "lead", "worker", "critic"])).min(1).optional(),
  capabilities: z.array(z.string()).default([]),
});

export const playbookSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** When true the developer-style stages need a project directory. */
  needsProjectDir: z.boolean().default(false),
  stages: z.array(stageSchema).min(1),
  /** slot id → what fills it. A stage name with no entry here must be an agent name outright.
   *  Optional rather than defaulted: a playbook written for one specific org needs none of this,
   *  and every Playbook built in code would otherwise have to carry an empty map. */
  bind: z.record(z.string(), bindingSchema).optional(),
});

export type Stage = z.infer<typeof stageSchema>;
export type Binding = z.infer<typeof bindingSchema>;
export type Playbook = z.infer<typeof playbookSchema>;

/** Every slot a playbook needs filled, across all three stage shapes. Deduped, in stage order.
 *  A slot is a role id resolved through `bind` (see registry/bind.ts) — or, for playbooks written
 *  against one specific org, an agent name that resolves to itself. */
export function playbookSlots(pb: Playbook): string[] {
  const out: string[] = [];
  const add = (n: string) => { if (n && !out.includes(n)) out.push(n); };
  for (const s of pb.stages) {
    if (s.type === "single") add(s.role);
    else if (s.type === "loop") { add(s.producer); add(s.critic); }
    else { add(s.runner); add(s.fixer); }
  }
  return out;
}

export function loadPlaybook(path: string): Playbook {
  return playbookSchema.parse(parse(readFileSync(path, "utf8")));
}

export function loadPlaybooks(dir: string): Map<string, Playbook> {
  const out = new Map<string, Playbook>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const pb = loadPlaybook(join(dir, file));
    out.set(pb.name, pb);
  }
  return out;
}
