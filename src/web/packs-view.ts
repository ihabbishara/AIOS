// src/web/packs-view.ts
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import { packSchema } from "../packs/types.js";
import { loadPlaybook } from "../engine/playbook.js";
import { roles } from "../agents/roles/index.js";

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

/**
 * Extract the primary role name from any stage type.
 * - single → role
 * - loop   → producer (the generating agent; critic is secondary)
 * - verify → runner (the executing agent; fixer is secondary)
 */
function stageRole(s: { type: string; role?: string; producer?: string; runner?: string }): string {
  return s.role ?? s.producer ?? s.runner ?? "?";
}

export function buildPacksView(config: Config, store: Store): PackView[] {
  const out: PackView[] = [];
  let entries: string[];
  try { entries = readdirSync(config.playbooksDir); } catch { return out; }

  const recentJobs = store.listJobs(500);

  for (const entry of entries) {
    const manifestPath = join(config.playbooksDir, entry, "pack.yaml");
    if (!existsSync(manifestPath)) continue;
    let pack: ReturnType<typeof packSchema.parse>;
    try { pack = packSchema.parse(parseYaml(readFileSync(manifestPath, "utf8"))); }
    catch { continue; } // skip a malformed manifest, like the loader

    const enabled = process.env[`AIOS_${pack.pillar.toUpperCase()}_DISABLED`] !== "1";

    const roleViews: PackRoleView[] = pack.roles.map((name) => {
      const def = roles[name];
      if (!def) return { name, description: "(missing role def)", privateOnly: false, advisoryInDirect: pack.sandbox, permissionMode: "?", allowedTools: [] };
      return {
        name,
        description: def.description,
        privateOnly: !!def.privateOnly,
        advisoryInDirect: pack.sandbox,
        permissionMode: def.permissionMode,
        allowedTools: def.allowedTools,
      };
    });

    const playbookViews: PackPlaybookView[] = [];
    for (const pbName of pack.playbooks) {
      const pbPath = join(config.playbooksDir, entry, `${pbName}.yaml`);
      if (!existsSync(pbPath)) continue;
      try {
        const pb = loadPlaybook(pbPath);
        playbookViews.push({
          name: pb.name,
          description: pb.description,
          needsProjectDir: !!pb.needsProjectDir,
          stages: pb.stages.map((s) => ({ id: s.id, type: s.type, role: stageRole(s as never) })),
        });
      } catch { /* skip an unparseable playbook */ }
    }

    const myJobs = recentJobs.filter((j) => pack.playbooks.includes(j.playbook)).slice(0, 10);
    const jobViews: PackJobView[] = myJobs.map((j) => ({
      id: j.id, title: j.title, playbook: j.playbook, status: j.status, created_at: j.created_at, projectDir: j.project_dir,
    }));

    const workspaces: PackWorkspaceView[] = [];
    if (pack.sandbox) {
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
      pillar: pack.pillar,
      persona: pack.persona,
      memoDomain: pack.memoDomain,
      vaultSection: pack.vaultSection,
      sandbox: pack.sandbox,
      enabled,
      toolServer: pack.toolServer,
      tools: pack.tools,
      actions: pack.actions,
      roles: roleViews,
      playbooks: playbookViews,
      recentJobs: jobViews,
      workspaces,
      memoCount: store.memoryStats(pack.memoDomain).count,
    });
  }
  return out;
}
