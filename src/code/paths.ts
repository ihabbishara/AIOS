// src/code/paths.ts
import { realpathSync, existsSync } from "node:fs";
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
