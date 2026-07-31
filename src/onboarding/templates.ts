// src/onboarding/templates.ts — org templates (spec §5). A template is a complete org: departments,
// agents, and the playbooks its agents are named in. Product data, used three ways — the wizard
// gallery, few-shot grounding for the Architect (plan 2b), and a QA baseline so templates cannot rot.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const NAME = /^[a-z][a-z0-9-]*$/;

/** Mirrors agentSchema's user-authored fields. maxTurns/permissionMode/visibility are rendered
 *  by renderAgentYaml at provision time — a template does not get to set them. */
export const templateAgentSchema = z.object({
  name: z.string().regex(NAME),
  department: z.string().regex(NAME),
  kind: z.enum(["coordinator", "lead", "worker", "critic"]),
  title: z.string().min(1),
  charter: z.string().min(1),
  persona: z.string().min(1),
  prompt: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export const templateDeptSchema = z.object({
  department: z.string().regex(NAME),
  mission: z.string().min(1),
  memoDomain: z.string().min(1),
  lead: z.string().regex(NAME).optional(),
  capabilities: z.array(z.string()).default([]),
  playbooks: z.array(z.string()).default([]),
});

export const orgTemplateSchema = z.object({
  name: z.string().regex(NAME),
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Shown on the first-job card (plan 3); carried through the proposal so the Architect
   *  and the gallery produce the same shape. */
  firstJob: z.string().min(1),
  departments: z.array(templateDeptSchema).min(1),
  agents: z.array(templateAgentSchema).min(1),
});

export type OrgTemplate = z.infer<typeof orgTemplateSchema>;
export type TemplateAgent = z.infer<typeof templateAgentSchema>;
export type TemplateDept = z.infer<typeof templateDeptSchema>;

const orgsDir = (templatesDir: string) => join(templatesDir, "orgs");

export function templatePlaybookDir(templatesDir: string, name: string): string {
  return join(orgsDir(templatesDir), name, "playbooks");
}

export function loadTemplate(templatesDir: string, name: string): OrgTemplate | undefined {
  if (!NAME.test(name)) return undefined; // also blocks "..": this name reaches join()
  const file = join(orgsDir(templatesDir), name, "org.yaml");
  if (!existsSync(file)) return undefined;
  return orgTemplateSchema.parse(parse(readFileSync(file, "utf8")));
}

/** Gallery rows. A broken template is logged and skipped — one bad file must never blank the
 *  gallery, which is the wizard's escape hatch when everything else has gone wrong. */
export function listTemplates(
  templatesDir: string, log: (l: string) => void = () => {},
): Array<{ name: string; title: string; summary: string }> {
  const root = orgsDir(templatesDir);
  if (!existsSync(root)) return [];
  const out: Array<{ name: string; title: string; summary: string }> = [];
  for (const name of readdirSync(root).sort()) {
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
      const t = loadTemplate(templatesDir, name);
      if (!t) continue;
      out.push({ name: t.name, title: t.title, summary: t.summary });
    } catch (err) {
      log(`org template ${name} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}
