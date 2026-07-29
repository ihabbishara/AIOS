// src/onboarding/mode.ts — first-run detection (onboarding spec §1).
// Presence check only: token *validity* is the auth step's SDK ping, not boot's job.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Agent yamls in non-underscore subdirs, excluding the department manifest (mirrors loader's walk). */
export function countAgentManifests(agentsDir: string): number {
  if (!existsSync(agentsDir)) return 0;
  let n = 0;
  for (const entry of readdirSync(agentsDir)) {
    if (entry.startsWith("_")) continue;
    const sub = join(agentsDir, entry);
    // One unreadable entry (dangling symlink, permissions) is a bad department, not a first run —
    // skip it so only an unreadable agentsDir itself can still throw.
    try {
      if (!statSync(sub).isDirectory()) continue;
      for (const f of readdirSync(sub)) {
        if (!/\.ya?ml$/.test(f) || f === "department.yaml" || f === "department.yml") continue;
        n++;
      }
    } catch {
      continue;
    }
  }
  return n;
}

export function bootMode(env: NodeJS.ProcessEnv, agentsDir: string): "setup" | "normal" {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) return "setup";
  return countAgentManifests(agentsDir) > 0 ? "normal" : "setup";
}
