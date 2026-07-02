import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { loadPlaybook, type Playbook } from "../../engine/playbook.js";
import { agentSchema, departmentSchema, type AgentManifest, type DepartmentManifest } from "./types.js";
import { VERDICT_SCHEMA, TEST_REPORT_SCHEMA, type RoleDef } from "../roles/index.js";
import type { ToolCheck } from "../guards/halalo-readonly.js";

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
}

export type LoadedDepartment = DepartmentManifest & { toolsUnion: string[] };

export interface LoadedRegistry {
  agents: Map<string, AgentDef>;
  departments: Map<string, LoadedDepartment>;
  /** name OR alias → canonical agent name */
  agentOf: Map<string, string>;
  ownerOfPlaybook: Map<string, string>;
  playbooks: Map<string, Playbook>;
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

function compile(m: AgentManifest, x: AgentExtras = {}): RoleDef {
  return {
    name: m.name,
    description: `${m.title} — ${m.charter.trim().split(/(?<=\.)\s/)[0]}`,
    systemPrompt: `${m.persona.trim()}\n\n${m.prompt.trim()}${x.promptSuffix ?? ""}`,
    allowedTools: m.tools,
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
        if (!/\.ya?ml$/.test(f) || f === "department.yaml") continue;
        let m: AgentManifest;
        try { m = agentSchema.parse(parse(readFileSync(join(dirPath, f), "utf8"))); }
        catch (err) { log(`agent ${dirName}/${f} skipped: ${(err as Error).message}`); continue; }
        if (m.department !== dirName) { log(`agent ${dirName}/${f} skipped: department mismatch`); continue; }
        if (agents.has(m.name) || agentOf.has(m.name)) { log(`agent ${dirName}/${f} skipped: duplicate name "${m.name}"`); continue; }
        const def: AgentDef = { manifest: m, role: compile(m, extras[m.name]), department: dept.department };
        agents.set(m.name, def);
        agentOf.set(m.name, m.name);
        for (const a of m.aliases) {
          if (agentOf.has(a)) { log(`agent ${m.name}: alias "${a}" dropped (already taken)`); continue; }
          agentOf.set(a, m.name);
        }
        members.push(def);
      }

      departments.set(dept.department, {
        ...dept,
        toolsUnion: [...new Set(members.flatMap((a) => a.manifest.tools))],
      });
      for (const pb of dept.playbooks) ownerOfPlaybook.set(pb, dept.department);
    } catch (err) {
      log(`agents entry ${dirName} skipped: ${(err as Error).message}`);
    }
  }
  return { agents, departments, agentOf, ownerOfPlaybook, playbooks };
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
