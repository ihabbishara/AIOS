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
import { deptWallViolations } from "../src/agents/registry/walls.js";
import { toolsFromCaps } from "../src/agents/registry/capabilities.js";

const templatesDir = join(process.cwd(), "templates");
const SHIPPED = ["founder", "personal-assistant", "researcher", "solo-dev", "starter"];

function provisionInTemp(name: string) {
  const root = mkdtempSync(join(tmpdir(), `tpl-${name}-`));
  const agentsDir = join(root, "agents");
  const playbooksDir = join(root, "playbooks");
  mkdirSync(playbooksDir, { recursive: true });
  const result = provision(templateToProposal(loadTemplate(templatesDir, name)!), {
    agentsDir, playbooksDir, templatesDir, loadRegistry,
  });
  if (!result.ok) {
    throw new Error(`${name}: ${result.errors.map((e) => `${e.name ?? e.scope}: ${e.error}`).join("; ")}`);
  }
  return { result, agentsDir, playbooksDir };
}

describe("shipped templates", () => {
  it("ships exactly the five v1 templates", () => {
    expect(listTemplates(templatesDir).map((t) => t.name).sort()).toEqual(SHIPPED);
  });

  for (const name of SHIPPED) {
    describe(name, () => {
      it("provisions through the real provisioner", () => {
        const { result } = provisionInTemp(name);
        expect(result.agents.length).toBeGreaterThan(0);
      });

      it("loads as a registry with exactly one coordinator and every department intact", () => {
        const { result, agentsDir, playbooksDir } = provisionInTemp(name);
        const reg = loadRegistry(agentsDir, playbooksDir);
        expect(reg.coordinator).toBeTruthy();
        expect(reg.agents.size).toBe(result.agents.length);
        // A department the loader skipped (bad manifest, missing playbook) would silently vanish.
        for (const d of result.departments) expect(reg.departments.has(d)).toBe(true);
      });

      it("violates no department capability wall", () => {
        const { agentsDir, playbooksDir } = provisionInTemp(name);
        const reg = loadRegistry(agentsDir, playbooksDir);
        for (const agent of reg.agents.values()) {
          const tools = toolsFromCaps(reg.capabilities, agent.capabilities);
          expect(deptWallViolations(agent.department, tools)).toEqual([]);
        }
      });

      it("resolves an owner for every playbook it ships", () => {
        const { result, agentsDir, playbooksDir } = provisionInTemp(name);
        const reg = loadRegistry(agentsDir, playbooksDir);
        for (const p of result.playbooks) {
          expect(reg.playbooks.has(p)).toBe(true);
          // Every stage role must resolve to a real agent, or the job dies at run time.
          for (const s of reg.playbooks.get(p)!.stages) {
            const roles = s.type === "single" ? [s.role]
              : s.type === "loop" ? [s.producer, s.critic]
              : [s.runner, s.fixer];
            for (const r of roles) expect(reg.agentOf.has(r)).toBe(true);
          }
        }
      });
    });
  }
});
