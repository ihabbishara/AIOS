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
  /** The daemon's own source root. A worktree request for a source under it is served as a
   *  clone: a worktree's .git points back into the real repo, which the sandbox denies. */
  selfRoot?: string;
  git?: (args: string[], cwd: string) => void;
}

/** A source repo to worktree/analyze must be a real git repo inside a read root,
 *  and must NOT be a secret path, AIOS, or the workspace root. Fail-closed. */
export function validateSource(source: string, deps: Pick<AllocateDeps, "readRoots" | "workspaceRoot" | "selfRoot">): void {
  const real = resolveReal(source);
  // The daemon's own tree is on the denylist so nothing can read the LIVE repo, but it is a
  // legitimate work source — allocateWorkspace serves it as a secret-free clone.
  const isSelf = Boolean(deps.selfRoot && isUnder(real, deps.selfRoot));
  if (!isSelf && isSecretPath(real)) throw new Error(`Refused: source path is on the secret denylist`);
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
  const source = resolveReal(opts.source);
  const branch = `aios/${opts.slug}-${deps.id}`;
  // Self-source ⇒ CLONE. A worktree's .git is a file pointing into the source repo, which the
  // sandbox denies for the daemon's own tree; a clone is self-contained, and because .env and
  // data/ are untracked it carries no secrets. --no-hardlinks so the copy shares no inodes.
  if (deps.selfRoot && isUnder(source, deps.selfRoot)) {
    git(["clone", "--no-hardlinks", "--quiet", source, taskDir], deps.workspaceRoot);
    git(["checkout", "-q", "-b", branch], taskDir);
    return { taskDir };
  }
  git(["worktree", "add", "-b", branch, taskDir, "HEAD"], source);
  return { taskDir };
}
