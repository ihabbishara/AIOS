import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadPlaybook, playbookAgents, type Playbook } from "../../engine/playbook.js";
import { agentSchema, departmentSchema, type AgentManifest, type DepartmentManifest } from "./types.js";
import { capabilitySchema, loadCapabilities, fqPackTool, toolsFromCaps, type CapabilityDef } from "./capabilities.js";
import { VERDICT_SCHEMA, TEST_REPORT_SCHEMA, type RoleDef } from "../roles/index.js";
import { NAMED_GUARDS } from "../guards/index.js";
import type { ToolCheck } from "../guards/halalo-readonly.js";

export type AgentKind = "coordinator" | "lead" | "worker" | "critic";

const SCHEMA_BY_NAME: Record<string, Record<string, unknown>> = {
  verdict: VERDICT_SCHEMA as unknown as Record<string, unknown>,
  "test-report": TEST_REPORT_SCHEMA as unknown as Record<string, unknown>,
};

/** Code-side extras merged into the compiled RoleDef (guards, env-dependent paths, prompt suffixes). */
export interface AgentExtras {
  toolChecks?: Record<string, ToolCheck>;
  toolCheckFallback?: "allow" | "deny";
  cwd?: string;
  contextFiles?: string[];
  attachDirs?: string[];
  promptSuffix?: string;
}

export interface AgentDef {
  manifest: AgentManifest;
  role: RoleDef;
  department: string;
  /** v2: org role — explicit in the manifest, or inferred by the migration shim. */
  kind: AgentKind;
  /** v2: effective capability names (dept defaults ∪ agent extras), deduped, boot-validated. */
  capabilities: string[];
}

export type LoadedDepartment = DepartmentManifest;

export interface LoadedRegistry {
  agents: Map<string, AgentDef>;
  departments: Map<string, LoadedDepartment>;
  /** name OR alias → canonical agent name */
  agentOf: Map<string, string>;
  ownerOfPlaybook: Map<string, string>;
  playbooks: Map<string, Playbook>;
  /** v2: capability definitions (agents/_capabilities.yaml + migration-shim synthetics). */
  capabilities: Map<string, CapabilityDef>;
  /** v2: canonical name of the single kind: coordinator agent (neo). */
  coordinator: string;
}

export const LEGACY_DISABLE_ALIAS: Record<string, string> = {
  code: "engineering", money: "finance", research: "research", lifeops: "life",
};

export function disabledDepartments(env: NodeJS.ProcessEnv, deptNames: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const d of deptNames) if (env[`AIOS_${d.toUpperCase()}_DISABLED`] === "1") out.add(d);
  for (const [legacy, dept] of Object.entries(LEGACY_DISABLE_ALIAS)) {
    if (env[`AIOS_${legacy.toUpperCase()}_DISABLED`] === "1") out.add(dept);
  }
  return out;
}

function compile(m: AgentManifest, x: AgentExtras = {}, allowedTools: string[] = []): RoleDef {
  return {
    name: m.name,
    description: `${m.title} — ${m.charter.trim().split(/(?<=\.)\s/)[0]}`,
    systemPrompt: `${m.persona.trim()}\n\n${m.prompt.trim()}${x.promptSuffix ?? ""}`,
    allowedTools,
    ...(m.model ? { model: m.model } : {}),
    permissionMode: m.permissionMode,
    maxTurns: m.maxTurns,
    ...(m.skills.length ? { skills: m.skills } : {}),
    ...(m.visibility === "private" ? { privateOnly: true } : {}),
    ...(m.outputSchema ? { outputSchema: SCHEMA_BY_NAME[m.outputSchema] } : {}),
    ...(x.cwd ? { cwd: x.cwd } : {}),
    ...(x.contextFiles ? { contextFiles: x.contextFiles } : {}),
    ...(x.toolChecks ? { toolChecks: x.toolChecks } : {}),
    ...(x.toolCheckFallback ? { toolCheckFallback: x.toolCheckFallback } : {}),
    ...(x.attachDirs ? { attachDirs: x.attachDirs } : {}),
  };
}

/** Scan playbooksDir like loadPacks: top-level *.yaml + one subdir level; manifest files ignored. */
function scanPlaybooks(dir: string, log: (l: string) => void): Map<string, Playbook> {
  const out = new Map<string, Playbook>();
  if (!existsSync(dir)) return out;
  const tryLoad = (full: string, label: string) => {
    try { const pb = loadPlaybook(full); out.set(pb.name, pb); }
    catch (err) { log(`playbook ${label} skipped: ${(err as Error).message}`); }
  };
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) {
        for (const f of readdirSync(full)) {
          if (!/\.ya?ml$/.test(f) || f === "pack.yaml" || f === "department.yaml") continue;
          tryLoad(join(full, f), `${entry}/${f}`);
        }
      } else if (/\.ya?ml$/.test(entry)) {
        tryLoad(full, entry);
      }
    } catch (err) {
      log(`playbooks entry ${entry} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}

export function loadRegistry(
  agentsDir: string,
  playbooksDir: string,
  extras: Record<string, AgentExtras> = {},
  log: (l: string) => void = () => {},
): LoadedRegistry {
  const agents = new Map<string, AgentDef>();
  const departments = new Map<string, LoadedDepartment>();
  const agentOf = new Map<string, string>();
  const ownerOfPlaybook = new Map<string, string>();
  const playbooks = scanPlaybooks(playbooksDir, log);
  const capabilities = loadCapabilities(join(agentsDir, "_capabilities.yaml"));

  for (const dirName of existsSync(agentsDir) ? readdirSync(agentsDir) : []) {
    const dirPath = join(agentsDir, dirName);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      const deptPath = join(dirPath, "department.yaml");
      if (!existsSync(deptPath)) continue;

      let dept: DepartmentManifest;
      try { dept = departmentSchema.parse(parse(readFileSync(deptPath, "utf8"))); }
      catch (err) { log(`department ${dirName} skipped: invalid manifest — ${(err as Error).message}`); continue; }
      if (dept.department !== dirName) { log(`department ${dirName} skipped: name mismatch "${dept.department}"`); continue; }
      if (departments.has(dept.department)) { log(`department ${dirName} skipped: duplicate`); continue; }
      if (dept.playbooks.some((p) => !playbooks.has(p))) {
        log(`department ${dirName} skipped: playbook missing — ${dept.playbooks.filter((p) => !playbooks.has(p)).join(", ")}`);
        continue;
      }

      const members: AgentDef[] = [];
      for (const f of readdirSync(dirPath).sort()) {
        if (!/\.ya?ml$/.test(f) || f === "department.yaml" || f.startsWith("_")) continue;
        let m: AgentManifest;
        try { m = agentSchema.parse(parse(readFileSync(join(dirPath, f), "utf8"))); }
        catch (err) { log(`agent ${dirName}/${f} skipped: ${(err as Error).message}`); continue; }
        if (m.department !== dirName) { log(`agent ${dirName}/${f} skipped: department mismatch`); continue; }
        // "user" is the human's mail identity and a security predicate (workspace gate) — reserved.
        if (m.name === "user") { log(`agent ${dirName}/${f} skipped: "user" is a reserved name`); continue; }
        if (agents.has(m.name) || agentOf.has(m.name)) {
          throw new Error(`agent name collision: "${m.name}" (${dirName}/${f}) is already registered`);
        }

        const capNames = [...new Set([...dept.capabilities, ...m.capabilities])];
        for (const c of capNames) {
          const capDef = capabilities.get(c);
          if (!capDef) throw new Error(`unknown capability "${c}" on agent ${m.name}`);
          if (capDef.guard && !(capDef.guard in NAMED_GUARDS)) {
            throw new Error(`unknown guard "${capDef.guard}" in capability "${c}" (agent ${m.name})`);
          }
        }
        const tools = toolsFromCaps(capabilities, capNames);

        const def: AgentDef = {
          manifest: m, role: compile(m, extras[m.name], tools), department: dept.department,
          kind: m.kind, capabilities: capNames,
        };
        agents.set(m.name, def);
        agentOf.set(m.name, m.name);
        for (const a of m.aliases) {
          if (a === "user") { log(`agent ${m.name}: alias "user" dropped (reserved)`); continue; }
          if (agentOf.has(a)) {
            throw new Error(`alias collision: "${a}" already registered (while loading ${m.name})`);
          }
          agentOf.set(a, m.name);
        }
        members.push(def);
      }

      departments.set(dept.department, dept);
      for (const pb of dept.playbooks) ownerOfPlaybook.set(pb, dept.department);
    } catch (err) {
      // Boot-check violations must escape (collision/capability/guard errors are fatal by design);
      // only filesystem/parse trouble is skip-and-log.
      if (/collision|unknown capability|unknown guard/.test((err as Error).message)) throw err;
      log(`agents entry ${dirName} skipped: ${(err as Error).message}`);
    }
  }

  const coordinators = [...agents.values()].filter((a) => a.kind === "coordinator").map((a) => a.manifest.name);
  // Exactly one coordinator when anything loaded at all; an entirely empty registry (all
  // departments skipped / bare test trees) has nothing to coordinate and passes through.
  if (coordinators.length > 1 || (coordinators.length === 0 && agents.size > 0)) {
    throw new Error(`exactly one kind: coordinator agent required, found ${coordinators.length} [${coordinators.join(", ")}]`);
  }
  const coordinator = coordinators[0] ?? "";

  // Drop playbooks whose agents this org does not have.
  //
  // Playbooks are scanned before any agent is read, so this cannot happen earlier. It matters
  // because playbooksDir is shared install state while agents/ is per-user: a cloned install
  // ships playbooks bound to the author's roster, and onboarding then provisions a completely
  // different one. Watched live on 2026-08-11 — a fresh three-agent org loaded all seven of the
  // author's playbooks, and its very first job died on "Unknown agent: clio".
  //
  // Offering a tool that cannot run is worse than not offering it, so drop and say so. Nothing
  // is deleted from disk and no department is skipped: a manifest may still name the playbook,
  // it simply can no longer be invoked.
  for (const [name, pb] of [...playbooks]) {
    const missing = playbookAgents(pb).filter((a) => !agentOf.has(a));
    if (!missing.length) continue;
    playbooks.delete(name);
    ownerOfPlaybook.delete(name);
    log(`playbook ${name} not offered: no such agent — ${missing.join(", ")}`);
  }

  return { agents, departments, agentOf, ownerOfPlaybook, playbooks, capabilities, coordinator };
}

/** Capability-truth base allowlist for an agent (fq-mapped) — what the web views show as
 *  "default" tools. Mirrors resolveAgent's tool union without building any servers. */
export function capabilityTools(reg: LoadedRegistry, canonical: string): string[] {
  const def = reg.agents.get(canonical);
  if (!def) return [];
  return [...new Set(
    def.capabilities.flatMap((c) => reg.capabilities.get(c)?.tools ?? []).map(fqPackTool),
  )];
}

/** Gate action-ceiling union for a department (dept defaults ∪ every member's capabilities). */
export function departmentActions(reg: LoadedRegistry, deptName: string): string[] {
  const dept = reg.departments.get(deptName);
  if (!dept) return [];
  const capNames = new Set(dept.capabilities);
  for (const a of reg.agents.values()) {
    if (a.department === deptName) for (const c of a.capabilities) capNames.add(c);
  }
  return [...new Set([...capNames].flatMap((c) => reg.capabilities.get(c)?.actions ?? []))];
}

/** Kill-switch: remove a department, its agents/aliases, and its playbooks. */
export function dropDepartment(reg: LoadedRegistry, dept: string): void {
  const d = reg.departments.get(dept);
  if (!d) return;
  for (const [name, def] of [...reg.agents]) {
    if (def.department !== dept) continue;
    reg.agents.delete(name);
    for (const [k, v] of [...reg.agentOf]) if (v === name) reg.agentOf.delete(k);
  }
  for (const pb of d.playbooks) { reg.playbooks.delete(pb); reg.ownerOfPlaybook.delete(pb); }
  reg.departments.delete(dept);
}
