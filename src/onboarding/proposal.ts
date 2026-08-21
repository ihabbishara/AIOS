// src/onboarding/proposal.ts — the seam between where an org comes from and how it lands.
// A template produces one of these today; the Org Architect will produce the same shape in
// plan 2b. The provisioner only ever sees an OrgProposal, so neither source can special-case it.
import type { OrgTemplate } from "./templates.js";

export interface ProposalDept {
  department: string; mission: string; memoDomain: string;
  lead?: string; capabilities: string[]; playbooks: string[];
}

export interface ProposalAgent {
  name: string; department: string;
  kind: "coordinator" | "lead" | "worker" | "critic";
  title: string; charter: string; persona: string; prompt: string;
  capabilities: string[]; skills: string[];
}

export interface OrgProposal {
  source: { kind: "template"; template: string } | { kind: "interview" };
  departments: ProposalDept[];
  agents: ProposalAgent[];
  /** Suggested first job — shown as the one-click card on the first-job step (plan 3). */
  firstJob: string;
}

/** Connect step follow-through: when a Gemini key is present, image generation should be
 *  usable out of the box — no shipped org template grants media-gen, so a key alone would
 *  unlock nothing. Workers and leads produce deliverables; critics review and the
 *  coordinator delegates, so those keep their surface. Applied at proposal CREATION so the
 *  grant is visible (and strippable) on the review screen's capability chips. */
export function grantMediaGen(p: OrgProposal): OrgProposal {
  return {
    ...p,
    agents: p.agents.map((a) =>
      (a.kind === "worker" || a.kind === "lead") && !a.capabilities.includes("media-gen")
        ? { ...a, capabilities: [...a.capabilities, "media-gen"] }
        : a,
    ),
  };
}

export function templateToProposal(t: OrgTemplate): OrgProposal {
  return {
    source: { kind: "template", template: t.name },
    departments: t.departments.map((d) => ({
      department: d.department, mission: d.mission, memoDomain: d.memoDomain,
      ...(d.lead ? { lead: d.lead } : {}), capabilities: d.capabilities, playbooks: d.playbooks,
    })),
    agents: t.agents.map((a) => ({
      name: a.name, department: a.department, kind: a.kind, title: a.title,
      charter: a.charter, persona: a.persona, prompt: a.prompt,
      capabilities: a.capabilities, skills: a.skills,
    })),
    firstJob: t.firstJob,
  };
}

/**
 * Structural gate: whole-proposal invariants that per-item validators cannot see, checked before
 * anything touches disk. The coordinator rule is the load-bearing one — loadRegistry throws when
 * agents load without exactly one (loader.ts:194), which would leave a written-but-unloadable org.
 */
export function proposalShape(p: unknown): { ok: true; proposal: OrgProposal } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail("proposal must be an object");
  const c = p as Partial<OrgProposal>;
  if (!Array.isArray(c.departments) || c.departments.length === 0) return fail("proposal needs at least one department");
  if (!Array.isArray(c.agents) || c.agents.length === 0) return fail("proposal needs at least one agent");
  if (typeof c.firstJob !== "string" || !c.firstJob.trim()) return fail("firstJob required");

  const depts = new Set<string>();
  for (const d of c.departments) {
    if (!d || typeof d.department !== "string") return fail("every department needs a name");
    if (depts.has(d.department)) return fail(`duplicate department "${d.department}" in proposal`);
    depts.add(d.department);
  }
  const names = new Set<string>();
  let coordinators = 0;
  for (const a of c.agents) {
    if (!a || typeof a.name !== "string") return fail("every agent needs a name");
    if (names.has(a.name)) return fail(`duplicate agent name "${a.name}" in proposal`);
    names.add(a.name);
    if (!depts.has(a.department)) {
      return fail(`agent "${a.name}" names department "${a.department}", which the proposal does not create`);
    }
    if (a.kind === "coordinator") coordinators++;
  }
  if (coordinators !== 1) return fail(`proposal needs exactly one coordinator, found ${coordinators}`);
  return { ok: true, proposal: c as OrgProposal };
}

/**
 * The same gate for an org that already exists. Every rule here is the FIRST-RUN rule turned
 * around, which is why it cannot share a code path with proposalShape:
 *
 *   - exactly one coordinator  ->  exactly ZERO. The org has one; a second makes the whole
 *     registry unloadable (loader.ts:194), and the failure would land after the write.
 *   - at least one department  ->  none required. Most growth is a new agent in a department
 *     that is already there.
 *   - departments the proposal creates  ->  those PLUS the ones the org already has.
 *   - names unique within the proposal  ->  unique against the live org too, which is the only
 *     place a collision can come from once setup is over.
 *
 * firstJob is not asked for: it is the wizard's one-click card, and there is no wizard here.
 */
export function growthShape(
  p: unknown, existing: { departments: Set<string>; agents: Set<string> },
): { ok: true; proposal: OrgProposal } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!p || typeof p !== "object" || Array.isArray(p)) return fail("proposal must be an object");
  const c = p as Partial<OrgProposal>;
  const departments = Array.isArray(c.departments) ? c.departments : [];
  if (!Array.isArray(c.agents) || c.agents.length === 0) return fail("nothing to add — propose at least one agent");

  const depts = new Set<string>();
  for (const d of departments) {
    if (!d || typeof d.department !== "string") return fail("every department needs a name");
    if (depts.has(d.department)) return fail(`duplicate department "${d.department}" in proposal`);
    if (existing.departments.has(d.department)) return fail(`department "${d.department}" already exists`);
    depts.add(d.department);
  }
  const names = new Set<string>();
  for (const a of c.agents) {
    if (!a || typeof a.name !== "string") return fail("every agent needs a name");
    if (names.has(a.name)) return fail(`duplicate agent name "${a.name}" in proposal`);
    if (existing.agents.has(a.name)) return fail(`agent "${a.name}" already exists`);
    names.add(a.name);
    if (!depts.has(a.department) && !existing.departments.has(a.department)) {
      return fail(`agent "${a.name}" names department "${a.department}", which does not exist and is not being created`);
    }
    if (a.kind === "coordinator") {
      return fail(`agent "${a.name}" is a coordinator — this org already has one, and two cannot load`);
    }
  }
  return { ok: true, proposal: { ...c, departments, firstJob: c.firstJob ?? "" } as OrgProposal };
}
