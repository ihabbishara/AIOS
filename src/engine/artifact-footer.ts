// src/engine/artifact-footer.ts — the deterministic "where to find it" block appended to every
// goal-completion report. The moderator's prose is asked to mention artifact locations, but a
// generated sentence is hope, not a guarantee — this footer is composed from the outcome itself,
// so the user always learns exactly where the files landed and how to open them.
import { join } from "node:path";
import type { GoalOutcome } from "./engine.js";

export function artifactFooter(
  outcome: GoalOutcome,
  opts: { vaultRoot: string; uiPort: number },  // vaultRoot = VaultWriter.root (already includes the subdir)
): string {
  const { goal, goalDirName, artifactFiles } = outcome;
  const dir = join(opts.vaultRoot, "goals", goalDirName);
  const lines = [
    "—",
    `📁 ${dir}`,
    ...(artifactFiles.length ? [`   ${artifactFiles.join(" · ")}`] : []),
    `   Open: http://localhost:${opts.uiPort}/#/goals/${goal.slug}  (or the goals/${goalDirName} folder in Obsidian)`,
  ];
  return `\n\n${lines.join("\n")}`;
}
