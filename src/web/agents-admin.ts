// src/web/agents-admin.ts — hire/fire builders (spec 2026-07-20). Pure; routes stay thin.
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { deptWallViolations } from "../agents/registry/walls.js";
import { toolsFromCaps } from "../agents/registry/capabilities.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { agentSchema } from "../agents/registry/types.js";

export interface HireBody {
  name: string; department: string; kind: "lead" | "worker" | "critic";
  title: string; charter: string; persona: string; prompt: string; capabilities: string[];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const KINDS = new Set(["lead", "worker", "critic"]);

export function validateHire(
  body: unknown, registry: LoadedRegistry,
): { ok: true; manifest: HireBody } | { ok: false; error: string } {
  const b = body as Partial<HireBody> | null;
  const fail = (error: string) => ({ ok: false as const, error });
  if (!b || typeof b !== "object") return fail("body required");
  if (typeof b.name !== "string" || !NAME_RE.test(b.name)) return fail("name must match ^[a-z][a-z0-9-]*$");
  if (registry.agentOf.has(b.name)) return fail(`name "${b.name}" is taken (agent or alias)`);
  if (typeof b.department !== "string" || !registry.departments.has(b.department)) {
    return fail(`unknown department "${String(b.department)}"`);
  }
  if (typeof b.kind !== "string" || !KINDS.has(b.kind)) {
    return fail("kind must be lead|worker|critic (coordinator cannot be hired)");
  }
  for (const f of ["title", "charter", "persona", "prompt"] as const) {
    if (typeof b[f] !== "string" || !b[f]!.trim()) return fail(`${f} required`);
  }
  if (!Array.isArray(b.capabilities)) return fail("capabilities must be an array");
  for (const c of b.capabilities) {
    if (typeof c !== "string" || !registry.capabilities.has(c)) return fail(`unknown capability "${String(c)}"`);
  }
  // Dept privacy wall: validate the tool surface the loader will actually grant (dept ∪ requested caps).
  const dept = registry.departments.get(b.department)!;
  const capNames = [...new Set([...dept.capabilities, ...(b.capabilities as string[])])];
  const violations = deptWallViolations(b.department, toolsFromCaps(registry.capabilities, capNames));
  if (violations.length > 0) {
    return fail(`capability wall: ${b.department} department agents may not carry ${violations.join(", ")}`);
  }
  const { name, department, kind, title, charter, persona, prompt, capabilities } = b as HireBody;
  return { ok: true, manifest: { name, department, kind, title, charter, persona, prompt, capabilities } };
}

/** Block scalar: arbitrary text as YAML `>`-folded block, 2-space indented, blank lines kept. */
const block = (s: string) => ">\n" + s.trim().split("\n").map((l) => (l.trim() ? `  ${l.trim()}` : "")).join("\n");

export function renderAgentYaml(m: HireBody): string {
  return [
    `name: ${m.name}`,
    `title: ${JSON.stringify(m.title)}`,
    `department: ${m.department}`,
    `charter: ${block(m.charter)}`,
    `persona: ${block(m.persona)}`,
    `prompt: ${block(m.prompt)}`,
    "maxTurns: 25",
    "permissionMode: dontAsk",
    `kind: ${m.kind}`,
    `capabilities: [${m.capabilities.join(", ")}]`,
    "",
  ].join("\n");
}

export interface DepartmentBody {
  department: string; mission: string; memoDomain: string;
  lead?: string; capabilities: string[]; playbooks: string[];
}

/**
 * The one new validated mutation onboarding needs (spec §4). Two rules come straight from the
 * loader: a department whose playbook is missing is SILENTLY SKIPPED at load (loader.ts:141) —
 * the org would come up short a department with no error anywhere — and the dir name must equal
 * the `department:` field, which the writer guarantees.
 *
 * `leadPending` is for provisioning, where the lead agent is written after its department.
 * `knownPlaybooks` is for provisioning too: template playbooks are copied in, so they are not
 * in the registry yet when the department is validated.
 */
export function validateDepartment(
  body: unknown, registry: LoadedRegistry,
  opts: { knownPlaybooks?: Set<string>; leadPending?: boolean } = {},
): { ok: true; manifest: DepartmentBody } | { ok: false; error: string } {
  const b = body as Partial<DepartmentBody> | null;
  const fail = (error: string) => ({ ok: false as const, error });
  if (!b || typeof b !== "object") return fail("body required");
  if (typeof b.department !== "string" || !NAME_RE.test(b.department)) {
    return fail("department must match ^[a-z][a-z0-9-]*$");
  }
  if (registry.departments.has(b.department)) return fail(`department "${b.department}" already exists`);
  for (const f of ["mission", "memoDomain"] as const) {
    if (typeof b[f] !== "string" || !b[f]!.trim()) return fail(`${f} required`);
  }
  const capabilities = b.capabilities ?? [];
  if (!Array.isArray(capabilities)) return fail("capabilities must be an array");
  for (const c of capabilities) {
    if (typeof c !== "string" || !registry.capabilities.has(c)) return fail(`unknown capability "${String(c)}"`);
  }
  const playbooks = b.playbooks ?? [];
  if (!Array.isArray(playbooks)) return fail("playbooks must be an array");
  for (const p of playbooks) {
    if (typeof p !== "string" || !(registry.playbooks.has(p) || opts.knownPlaybooks?.has(p))) {
      return fail(`unknown playbook "${String(p)}"`);
    }
  }
  if (b.lead !== undefined) {
    if (typeof b.lead !== "string" || !NAME_RE.test(b.lead)) return fail("lead must match ^[a-z][a-z0-9-]*$");
    if (!opts.leadPending && !registry.agentOf.has(b.lead)) {
      return fail(`lead "${b.lead}" is not a registered agent`);
    }
  }
  const { department, mission, memoDomain, lead } = b as DepartmentBody;
  return {
    ok: true,
    manifest: { department, mission, memoDomain, ...(lead ? { lead } : {}), capabilities, playbooks },
  };
}

export function renderDepartmentYaml(m: DepartmentBody): string {
  return [
    `department: ${m.department}`,
    `mission: ${block(m.mission)}`,
    ...(m.lead ? [`lead: ${m.lead}`] : []),
    `memoDomain: ${m.memoDomain}`,
    `capabilities: [${m.capabilities.join(", ")}]`,
    `playbooks: [${m.playbooks.join(", ")}]`,
    "",
  ].join("\n");
}

export function retireBlockers(canonical: string, registry: LoadedRegistry): string[] {
  const out: string[] = [];
  const def = registry.agents.get(canonical);
  if (!def) return [`unknown agent "${canonical}"`];
  if (def.kind === "coordinator") out.push(`${canonical} is the coordinator — the org requires exactly one`);
  for (const d of registry.departments.values()) {
    if (d.lead === canonical) out.push(`${canonical} is lead of ${d.department}`);
  }
  for (const [pbName, pb] of registry.playbooks) {
    for (const s of pb.stages) {
      // Every stage type names agents differently: single→role, loop→producer/critic, verify→runner/fixer.
      const roles = s.type === "single" ? [s.role] : s.type === "loop" ? [s.producer, s.critic] : [s.runner, s.fixer];
      if (roles.some((r) => (registry.agentOf.get(r) ?? r) === canonical)) {
        out.push(`referenced by playbook ${pbName} stage ${s.id}`);
      }
    }
  }
  return out;
}

/** Archived manifests in agents/_retired/ — one row per yaml; a bad file becomes {name, error}, never a throw. */
export function listRetired(archiveDir: string): Array<{ name: string; department?: string; kind?: string; title?: string; error?: string }> {
  if (!existsSync(archiveDir)) return [];
  return readdirSync(archiveDir).filter((f) => f.endsWith(".yaml")).map((f) => {
    const name = f.replace(/\.yaml$/, "");
    try {
      const m = agentSchema.parse(parseYaml(readFileSync(join(archiveDir, f), "utf8")));
      return { name: m.name, department: m.department, kind: m.kind, title: m.title };
    } catch (err) {
      return { name, error: (err as Error).message };
    }
  });
}

/** Rehire = validate-and-move. Reuses validateHire so collisions, dept existence, and dept walls
 *  apply to the archived manifest exactly as they would to a fresh hire. */
export function validateRehire(
  name: string, archiveDir: string, agentsDir: string, registry: LoadedRegistry,
): { ok: true; manifest: HireBody; from: string; to: string } | { ok: false; status: number; error: string } {
  const from = join(archiveDir, `${name}.yaml`);
  if (!existsSync(from)) return { ok: false, status: 404, error: `no retired agent "${name}"` };
  let m: ReturnType<typeof agentSchema.parse>;
  try {
    m = agentSchema.parse(parseYaml(readFileSync(from, "utf8")));
  } catch (err) {
    return { ok: false, status: 400, error: `archived manifest invalid: ${(err as Error).message}` };
  }
  const v = validateHire(
    { name: m.name, department: m.department, kind: m.kind as HireBody["kind"], title: m.title,
      charter: m.charter, persona: m.persona, prompt: m.prompt, capabilities: m.capabilities },
    registry,
  );
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  return { ok: true, manifest: v.manifest, from, to: join(agentsDir, m.department, `${m.name}.yaml`) };
}
