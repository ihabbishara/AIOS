// scripts/eval-architect.ts — 5 fixture personas through the real Architect.
// NEVER in vitest: LLM-flaky by design, and it needs live subscription auth.
//   npx tsx scripts/eval-architect.ts
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArchitectContext, interviewTurn, sdkArchitect, type Turn } from "../src/onboarding/architect.js";
import { listTemplates, loadTemplate } from "../src/onboarding/templates.js";
import { listSkills, skillsPluginRoot } from "../src/web/skills-view.js";
import { loadCapabilities } from "../src/agents/registry/capabilities.js";
import { CAPABILITIES_FILE } from "../src/onboarding/seed.js";
import { provision } from "../src/onboarding/provision.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

interface Persona {
  name: string;
  answers: string[];
  expect: { minAgents: number; maxAgents: number; maxDepartments: number };
}

// Top-level await breaks under `npx tsx` run from this repo (it resolves the CJS output),
// so everything goes inside an async main.
async function main(): Promise<void> {
  const templatesDir = join(process.cwd(), "templates");
  const personas = JSON.parse(readFileSync("scripts/fixtures/architect-personas.json", "utf8")) as Persona[];

  // templates/, not agents/ — this is what a fresh install's Architect actually sees, which is
  // the thing being evaluated. The user's agents dir has no catalog until provision.
  const context = buildArchitectContext({
    capabilities: [...loadCapabilities(join(templatesDir, CAPABILITIES_FILE))]
      .map(([name, def]) => ({ name, labels: def.labels })),
    skills: listSkills(skillsPluginRoot()),
    templates: listTemplates(templatesDir)
      .map((t) => loadTemplate(templatesDir, t.name))
      .filter((t): t is NonNullable<typeof t> => Boolean(t)),
  });

  let passed = 0;
  for (const p of personas) {
    const turns: Turn[] = [];
    let verdict = "no proposal after every answer was given";
    try {
      for (const answer of p.answers) {
        turns.push({ role: "user", text: answer });
        const r = await interviewTurn(turns, context, sdkArchitect);
        if (!r.done) { turns.push({ role: "architect", text: r.question }); continue; }

        const { proposal } = r;
        const problems: string[] = [];
        if (proposal.agents.length < p.expect.minAgents) problems.push(`only ${proposal.agents.length} agents`);
        if (proposal.agents.length > p.expect.maxAgents) problems.push(`${proposal.agents.length} agents`);
        if (proposal.departments.length > p.expect.maxDepartments) problems.push(`${proposal.departments.length} departments`);

        // The real bar: does it actually provision? Same provisioner the wizard uses.
        const root = mkdtempSync(join(tmpdir(), `eval-${p.name}-`));
        const agentsDir = join(root, "agents"), playbooksDir = join(root, "playbooks");
        mkdirSync(playbooksDir, { recursive: true });
        const prov = provision(proposal, { agentsDir, playbooksDir, templatesDir, loadRegistry });
        if (!prov.ok) problems.push(...prov.errors.map((e) => `${e.name ?? e.scope}: ${e.error}`));

        verdict = problems.length === 0
          ? `PASS (${proposal.agents.length} agents, ${proposal.departments.length} depts, ${turns.filter((t) => t.role === "architect").length} questions)`
          : `FAIL — ${problems.join("; ")}`;
        break;
      }
    } catch (err) {
      verdict = `FAIL — ${(err as Error).message}`;
    }
    if (verdict.startsWith("PASS")) passed++;
    console.log(`${p.name.padEnd(14)} ${verdict}`);
  }
  console.log(`\n${passed}/${personas.length} personas produced a provisionable org.`);
}

void main();
