// src/onboarding/artifacts.ts — what the first job left behind, so the wizard can point at it.
//
// The first job goes through moderator.handle(), which is the CHAT path: the coordinator answers,
// and a goal exists only if it decides to plan one. So the wizard's Result panel showed a wall of
// prose and nothing else, while the actual deliverable — a research report the org had just filed
// in the vault — went unmentioned. The user's reading of that was "the job ran but I cannot find
// it anywhere", which is the correct reading of what the screen said.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Vault surfaces the heartbeat owns. They churn on their own schedule — a brief written while
 *  the job happened to be running is not something the job produced, and claiming otherwise is
 *  worse than saying nothing. Matched as top-level names only. */
const HEARTBEAT = new Set(["briefs", "wiki", "daily", "log.md", "index.md", "CLAUDE.md"]);

/** Relative paths of every vault file the org could plausibly have written as job output.
 *  Missing root is empty, not an error: the boot may have failed and the wizard still renders. */
export function vaultSnapshot(root: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(root)) return out;
  const walk = (dir: string, rel: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      if (!rel && HEARTBEAT.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full, relPath);
        else out.add(relPath);
      } catch { /* raced with a writer — not this function's problem */ }
    }
  };
  walk(root, "");
  return out;
}

/** Files present after the job that were not there before it. Sorted so the screen is stable. */
export function newFiles(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((f) => !before.has(f)).sort();
}
