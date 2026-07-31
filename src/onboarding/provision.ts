// src/onboarding/provision.ts — the one mutation path from proposal to a live org (spec §4).
//
// Three constraints shape this, all from the loader:
//   1. WRITE EVERYTHING, THEN RELOAD ONCE. A lone non-coordinator agent is an invalid registry
//      (loader.ts:194), so there is no valid intermediate state to reload into.
//   2. PLAYBOOKS FIRST. A department naming a playbook the loader cannot find is silently
//      skipped (loader.ts:141), so the org would come up short a department with no error.
//   3. COMPENSATE ON ANY FAILURE. Delete everything this call created, newest first, so a
//      rejected proposal leaves the disk exactly as it found it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedRegistry } from "../agents/registry/loader.js";
import {
  renderAgentYaml, renderDepartmentYaml, validateDepartment, validateProposalAgent,
} from "../web/agents-admin.js";
import { proposalShape, type OrgProposal } from "./proposal.js";
import { seedCapabilities } from "./seed.js";
import { templatePlaybookDir } from "./templates.js";

export interface ProvisionDeps {
  agentsDir: string;
  playbooksDir: string;
  templatesDir: string;
  /** Injected so a test can make the verification reload fail and prove compensation. */
  loadRegistry: (agentsDir: string, playbooksDir: string) => LoadedRegistry;
  log?: (l: string) => void;
}

export interface ProposalError {
  scope: "proposal" | "department" | "agent";
  name?: string;
  error: string;
}

export type ProvisionResult =
  | { ok: true; departments: string[]; agents: string[]; playbooks: string[] }
  | { ok: false; errors: ProposalError[] };

export function provision(proposal: OrgProposal, deps: ProvisionDeps): ProvisionResult {
  const log = deps.log ?? (() => {});
  const shape = proposalShape(proposal);
  if (!shape.ok) return { ok: false, errors: [{ scope: "proposal", error: shape.error }] };

  seedCapabilities(deps.agentsDir, deps.templatesDir);
  const before = deps.loadRegistry(deps.agentsDir, deps.playbooksDir);

  // Everything this call creates, so compensation can be exact. Reverse order on unwind:
  // files before the directories that hold them.
  const files: string[] = [];
  const dirs: string[] = [];
  const undo = (): void => {
    for (const f of [...files].reverse()) if (existsSync(f)) unlinkSync(f);
    for (const d of [...dirs].reverse()) if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d);
  };

  // --- Playbooks first (constraint 2). Names the install already has win: an existing playbook
  // is the user's, and clobbering it would rewire jobs they already run.
  const playbooks: string[] = [];
  if (proposal.source.kind === "template") {
    const from = templatePlaybookDir(deps.templatesDir, proposal.source.template);
    if (existsSync(from)) {
      mkdirSync(deps.playbooksDir, { recursive: true });
      for (const f of readdirSync(from).filter((n) => /\.ya?ml$/.test(n))) {
        const target = join(deps.playbooksDir, f);
        if (existsSync(target)) { log(`playbook ${f} already present — kept`); continue; }
        copyFileSync(join(from, f), target);
        files.push(target);
        playbooks.push(f.replace(/\.ya?ml$/, ""));
      }
    }
  }

  // --- Validate departments. Leads are pending (their agents are written after) and the
  // just-copied playbooks are not in `before` yet.
  const known = new Set([...before.playbooks.keys(), ...playbooks]);
  const errors: ProposalError[] = [];
  for (const d of proposal.departments) {
    const v = validateDepartment(d, before, { knownPlaybooks: known, leadPending: true });
    if (!v.ok) errors.push({ scope: "department", name: d.department, error: v.error });
  }

  // --- Validate agents against the departments this proposal creates plus whatever exists.
  const knownDepartments = new Set([
    ...before.departments.keys(), ...proposal.departments.map((d) => d.department),
  ]);
  const taken = new Set<string>();
  for (const a of proposal.agents) {
    const v = validateProposalAgent(a, before, { knownDepartments, taken });
    if (!v.ok) errors.push({ scope: "agent", name: a.name, error: v.error });
    else taken.add(a.name);
  }
  if (errors.length) { undo(); return { ok: false, errors }; }

  // --- Write. Departments then agents; nothing is loaded until all of it is on disk.
  try {
    for (const d of proposal.departments) {
      const dir = join(deps.agentsDir, d.department);
      if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); dirs.push(dir); }
      const file = join(dir, "department.yaml");
      writeFileSync(file, renderDepartmentYaml({
        department: d.department, mission: d.mission, memoDomain: d.memoDomain,
        ...(d.lead ? { lead: d.lead } : {}), capabilities: d.capabilities, playbooks: d.playbooks,
      }));
      files.push(file);
    }
    for (const a of proposal.agents) {
      const file = join(deps.agentsDir, a.department, `${a.name}.yaml`);
      writeFileSync(file, renderAgentYaml(a));
      files.push(file);
    }
    // Constraint 1: the single reload that proves the whole org is loadable.
    deps.loadRegistry(deps.agentsDir, deps.playbooksDir);
  } catch (err) {
    undo();
    return { ok: false, errors: [{ scope: "proposal", error: `provision failed: ${(err as Error).message}` }] };
  }

  log(`provisioned ${proposal.departments.length} departments, ${proposal.agents.length} agents`);
  return {
    ok: true,
    departments: proposal.departments.map((d) => d.department),
    agents: proposal.agents.map((a) => a.name),
    playbooks,
  };
}
