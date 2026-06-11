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

export const playbookSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** When true the developer-style stages need a project directory. */
  needsProjectDir: z.boolean().default(false),
  stages: z.array(stageSchema).min(1),
});

export type Stage = z.infer<typeof stageSchema>;
export type Playbook = z.infer<typeof playbookSchema>;

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
