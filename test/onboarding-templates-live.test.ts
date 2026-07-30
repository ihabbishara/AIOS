// test/onboarding-templates-live.test.ts — spec §9: every shipped template is provisioned through
// the REAL provisioner, so a template cannot rot without the suite saying so.
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { listTemplates, loadTemplate } from "../src/onboarding/templates.js";
import { templateToProposal } from "../src/onboarding/proposal.js";
import { provision } from "../src/onboarding/provision.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

const templatesDir = join(process.cwd(), "templates");

describe("shipped templates", () => {
  it("ships the starter template", () => {
    expect(listTemplates(templatesDir).map((t) => t.name)).toContain("starter");
  });

  it("provisions starter into a live registry", () => {
    const root = mkdtempSync(join(tmpdir(), "tpl-live-"));
    const agentsDir = join(root, "agents");
    const playbooksDir = join(root, "playbooks");
    mkdirSync(playbooksDir, { recursive: true });

    const r = provision(templateToProposal(loadTemplate(templatesDir, "starter")!), {
      agentsDir, playbooksDir, templatesDir, loadRegistry,
    });
    if (!r.ok) throw new Error(r.errors.map((e) => `${e.name ?? e.scope}: ${e.error}`).join("; "));

    const reg = loadRegistry(agentsDir, playbooksDir);
    expect(reg.coordinator).toBeTruthy();
    expect(reg.agents.size).toBe(r.agents.length);
    // Every department the template declares actually survived the load.
    for (const d of r.departments) expect(reg.departments.has(d)).toBe(true);
    // Every playbook the template ships resolves.
    for (const p of r.playbooks) expect(reg.playbooks.has(p)).toBe(true);
  });
});
