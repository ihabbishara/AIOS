// src/code/workspace.ts
import { mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isUnder, isSecretPath, resolveReal } from "./paths.js";

export type WorkspaceMode = "greenfield" | "worktree" | "analyze";

export interface AllocateDeps {
  workspaceRoot: string;
  readRoots: string[];
  now: string;            // YYYY-MM-DD, injected for determinism
  id: string;             // short unique id, injected
  git?: (args: string[], cwd: string) => void;
}

/** A source repo to worktree/analyze must be a real git repo inside a read root,
 *  and must NOT be a secret path, AIOS, or the workspace root. Fail-closed. */
export function validateSource(source: string, deps: Pick<AllocateDeps, "readRoots" | "workspaceRoot">): void {
  const real = resolveReal(source);
  if (isSecretPath(real)) throw new Error(`Refused: source path is on the secret denylist`);
  if (!deps.readRoots.some((root) => isUnder(real, root))) {
    throw new Error(`Refused: source is outside the allowed read roots [${deps.readRoots.join(", ")}]`);
  }
  if (isUnder(real, deps.workspaceRoot)) throw new Error(`Refused: source is inside the workspace root`);
  if (!existsSync(join(real, ".git"))) throw new Error(`Not a git repo: ${source}`);
}

export function allocateWorkspace(
  opts: { mode: WorkspaceMode; source?: string; slug: string },
  deps: AllocateDeps,
): { taskDir: string } {
  if (opts.mode === "analyze") {
    if (!opts.source) throw new Error("analyze mode needs a source repo");
    validateSource(opts.source, deps);
    return { taskDir: resolveReal(opts.source) }; // read-only; guard blocks writes
  }

  const taskDir = join(deps.workspaceRoot, `${deps.now}-${opts.slug}-${deps.id}`);
  mkdirSync(deps.workspaceRoot, { recursive: true });

  if (opts.mode === "greenfield") {
    mkdirSync(taskDir, { recursive: true });
    return { taskDir };
  }

  // worktree
  if (!opts.source) throw new Error("worktree mode needs a source repo");
  validateSource(opts.source, deps);
  const git = deps.git ?? ((args, cwd) => { execFileSync("git", args, { cwd }); });
  git(["worktree", "add", "-b", `aios/${opts.slug}-${deps.id}`, taskDir, "HEAD"], resolveReal(opts.source));
  return { taskDir };
}
