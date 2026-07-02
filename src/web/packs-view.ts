// src/web/packs-view.ts
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import { agentSchema, departmentSchema } from "../agents/registry/types.js";
import { loadPlaybook, playbookSchema } from "../engine/playbook.js";

// Reverse-alias map: new dept name → legacy env name
const DEPT_LEGACY_ENV: Record<string, string> = {
  engineering: "CODE", finance: "MONEY", life: "LIFEOPS", research: "RESEARCH",
};

export interface PackRoleView {
  name: string;
  description: string;
  privateOnly: boolean;
  advisoryInDirect: boolean;
  permissionMode: string;
  allowedTools: string[];
}
export interface PackPlaybookView {
  name: string;
  description: string;
  needsProjectDir: boolean;
  stages: Array<{ id: string; type: string; role: string }>;
}
export interface PackJobView {
  id: string; title: string; playbook: string; status: string; created_at: string; projectDir: string | null;
}
export interface PackWorkspaceView { taskDir: string; exists: boolean; jobId: string; title: string; status: string; }
export interface PackView {
  pillar: string;
  persona: string;
  memoDomain: string;
  vaultSection: string;
  sandbox: boolean;
  enabled: boolean;
  toolServer?: string;
  tools: string[];
  actions: string[];
  roles: PackRoleView[];
  playbooks: PackPlaybookView[];
  recentJobs: PackJobView[];
  workspaces: PackWorkspaceView[];
  memoCount: number;
}

function stageRole(s: { type: string; role?: string; producer?: string; runner?: string }): string {
  return s.role ?? s.producer ?? s.runner ?? "?";
}

function isDeptEnabled(deptName: string): boolean {
  if (process.env[`AIOS_${deptName.toUpperCase()}_DISABLED`] === "1") return false;
  const legacyKey = DEPT_LEGACY_ENV[deptName];
  if (legacyKey && process.env[`AIOS_${legacyKey}_DISABLED`] === "1") return false;
  return true;
}

export function buildPacksView(config: Config, store: Store): PackView[] {
  const out: PackView[] = [];
  const agentsDir = config.agentsDir;
  let entries: string[];
  try { entries = readdirSync(agentsDir); } catch { return out; }

  const recentJobs = store.listJobs(500);

  for (const entry of entries) {
    const deptDir = join(agentsDir, entry);
    let isDir = false;
    try { isDir = statSync(deptDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    const deptPath = join(deptDir, "department.yaml");
    if (!existsSync(deptPath)) continue;

    let dept: ReturnType<typeof departmentSchema.parse>;
    try { dept = departmentSchema.parse(parseYaml(readFileSync(deptPath, "utf8"))); }
    catch { continue; }

    const enabled = isDeptEnabled(dept.department);

    // Load agents in this dept to build roles view + tools union
    const roleViews: PackRoleView[] = [];
    const toolsSet = new Set<string>();
    for (const f of readdirSync(deptDir)) {
      if (!/\.ya?ml$/.test(f) || f === "department.yaml") continue;
      try {
        const m = agentSchema.parse(parseYaml(readFileSync(join(deptDir, f), "utf8")));
        if (m.department !== dept.department) continue;
        for (const t of m.tools) toolsSet.add(t);
        const desc = `${m.title} — ${m.charter.trim().split(/(?<=\.)\s/)[0]}`;
        roleViews.push({
          name: m.name,
          description: desc,
          privateOnly: m.visibility === "private",
          advisoryInDirect: dept.sandbox,
          permissionMode: m.permissionMode,
          allowedTools: m.tools,
        });
      } catch { /* skip bad agent file */ }
    }

    const playbookViews: PackPlaybookView[] = [];
    for (const pbName of dept.playbooks) {
      // Playbooks live in playbooksDir: try subdir first, then flat
      const pbPath = existsSync(join(config.playbooksDir, entry, `${pbName}.yaml`))
        ? join(config.playbooksDir, entry, `${pbName}.yaml`)
        : join(config.playbooksDir, `${pbName}.yaml`);
      if (!existsSync(pbPath)) continue;
      try {
        const pb = loadPlaybook(pbPath);
        playbookViews.push({
          name: pb.name,
          description: pb.description,
          needsProjectDir: !!pb.needsProjectDir,
          stages: pb.stages.map((s) => ({ id: s.id, type: s.type, role: stageRole(s as never) })),
        });
      } catch { /* skip */ }
    }

    const myJobs = recentJobs.filter((j) => dept.playbooks.includes(j.playbook)).slice(0, 10);
    const jobViews: PackJobView[] = myJobs.map((j) => ({
      id: j.id, title: j.title, playbook: j.playbook, status: j.status, created_at: j.created_at, projectDir: j.project_dir,
    }));

    const workspaces: PackWorkspaceView[] = [];
    if (dept.sandbox && config.workspaceRoot) {
      const seen = new Set<string>();
      for (const j of myJobs) {
        const dir = j.project_dir;
        if (!dir || seen.has(dir) || !dir.startsWith(config.workspaceRoot + "/")) continue;
        seen.add(dir);
        let exists = false;
        try { exists = statSync(dir).isDirectory(); } catch { exists = false; }
        workspaces.push({ taskDir: dir, exists, jobId: j.id, title: j.title, status: j.status });
      }
    }

    out.push({
      pillar: dept.department,
      persona: dept.mission,
      memoDomain: dept.memoDomain,
      vaultSection: dept.vaultSection,
      sandbox: dept.sandbox,
      enabled,
      toolServer: dept.toolServer,
      tools: [...toolsSet],
      actions: dept.actions,
      roles: roleViews,
      playbooks: playbookViews,
      recentJobs: jobViews,
      workspaces,
      memoCount: store.memoryStats(dept.memoDomain).count,
    });
  }
  return out;
}

/** The env var that disables a department at boot. */
export function packDisableKey(dept: string): string {
  return `AIOS_${dept.toUpperCase()}_DISABLED`;
}

export interface RunValidation { ok: boolean; error?: string; projectDir?: string; }
export interface FileValidation { ok: boolean; error?: string; }
export type PackFileType = "department" | "agent" | "playbook";

/** Validate a department, agent, or playbook file before write.
 *  fileType drives schema selection; "agent" additionally checks dept + name/filename alignment. */
export function validatePackFile(
  name: string,
  yaml: string,
  fileType: PackFileType,
  dept?: string,
): FileValidation {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return { ok: false, error: "illegal filename" };
  if (!/^[\w.-]+\.ya?ml$/.test(name)) return { ok: false, error: "must be a .yaml file" };
  try {
    const parsed = parseYaml(yaml);
    if (fileType === "department") {
      departmentSchema.parse(parsed);
    } else if (fileType === "agent") {
      if (!dept) return { ok: false, error: "dept is required for agent validation" };
      const manifest = agentSchema.parse(parsed);
      if (manifest.department !== dept) return { ok: false, error: `manifest.department must be "${dept}"` };
      const stem = name.replace(/\.ya?ml$/, "");
      if (manifest.name !== stem) return { ok: false, error: `manifest.name must be "${stem}"` };
    } else {
      playbookSchema.parse(parsed);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Validate a pack-run request against the on-disk department manifest + the projects-root guard. */
export function validateRunRequest(config: Config, dept: string, playbook: string, projectDir?: string): RunValidation {
  const agentsDir = config.agentsDir;
  const deptPath = join(agentsDir, dept, "department.yaml");
  if (!existsSync(deptPath)) return { ok: false, error: `unknown department: ${dept}` };
  let deptManifest: ReturnType<typeof departmentSchema.parse>;
  try { deptManifest = departmentSchema.parse(parseYaml(readFileSync(deptPath, "utf8"))); }
  catch (e) { return { ok: false, error: `bad manifest: ${(e as Error).message}` }; }
  if (!deptManifest.playbooks.includes(playbook)) return { ok: false, error: `playbook ${playbook} not in department ${dept}` };
  if (projectDir) {
    const dir = resolve(projectDir);
    const root = resolve(config.projectsRoot);
    if (dir !== root && !dir.startsWith(root + sep)) return { ok: false, error: `project_dir must be under ${root}` };
    return { ok: true, projectDir: dir };
  }
  return { ok: true };
}
