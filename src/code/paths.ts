// src/code/paths.ts
import { realpathSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** Realpath the nearest existing ancestor, then re-append the not-yet-existing tail.
 *  Collapses `..` and symlinks in the part that exists — the part an attacker controls. */
export function resolveReal(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
  const realBase = existsSync(cur) ? realpathSync(cur) : cur;
  return tail.length ? join(realBase, ...tail) : realBase;
}

/** True iff `child` resolves to `parent` or a path strictly below it. */
export function isUnder(child: string, parent: string): boolean {
  const c = resolveReal(child);
  const base = resolveReal(parent);
  return c === base || c.startsWith(base.endsWith(sep) ? base : base + sep);
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.config(\/|$)/,
  /(^|\/)projects\/AIOS(\/|$)/,
  /\.env(\.[^/]+)?$/,
  /(token|credential|secret)/i,
];

/** Hard denylist that always wins over any read-root. */
export function isSecretPath(p: string): boolean {
  const r = resolveReal(p);
  return SECRET_PATTERNS.some((re) => re.test(r));
}

/** Guard an in-place coding target. Refuses (fail-closed) the AIOS source tree, secret paths,
 *  the sandbox workspace, anything outside projectsRoot, and non-directories. selfRoot is the
 *  daemon's own source root (caller passes resolveReal(process.cwd())). */
export function assertInplaceTarget(
  target: string,
  roots: { selfRoot: string; workspaceRoot: string; projectsRoot: string },
): void {
  let real: string;
  try {
    real = resolveReal(target);
  } catch {
    throw new Error("Refused: cannot resolve inplace target");
  }
  if (isUnder(real, roots.selfRoot) || isUnder(roots.selfRoot, real)) {
    throw new Error("Refused: inplace cannot target the AIOS source tree");
  }
  if (isSecretPath(real)) throw new Error("Refused: inplace target is on the secret denylist");
  if (isUnder(real, roots.workspaceRoot)) throw new Error("Refused: inplace target is inside the sandbox workspace");
  if (!isUnder(real, roots.projectsRoot)) throw new Error(`Refused: inplace target must be under ${roots.projectsRoot}`);
  if (!existsSync(real) || !statSync(real).isDirectory()) {
    throw new Error(`Refused: inplace target is not an existing directory: ${target}`);
  }
}
