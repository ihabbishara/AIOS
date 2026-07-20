// src/web/agents-admin.ts — hire/fire builders (spec 2026-07-20). Pure; routes stay thin.
import type { LoadedRegistry } from "../agents/registry/loader.js";
import { deptWallViolations } from "../agents/registry/walls.js";
import { toolsFromCaps } from "../agents/registry/capabilities.js";

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
