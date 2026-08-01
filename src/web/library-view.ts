// src/web/library-view.ts — pure builders behind /api/library (spec §4). Read-only.
// Containment is the whole risk surface here, so it lives in one function with no HTTP
// around it: resolve the real path (following symlinks) and require it under the root.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { LibraryNode } from "./dto.js";

export type { LibraryNode } from "./dto.js";

const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".json": "application/json", ".csv": "text/csv", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf",
};

const DEFAULT_DEPTH = 6;

/** True iff an already-resolved `real` is the base itself or strictly below it. The `+ sep`
 *  is what stops a sibling named `<base>evil` from passing a bare startsWith. */
function within(base: string, real: string): boolean {
  return real === base || real.startsWith(base + sep);
}

/** Resolve `rel` against `root` and prove it stays inside. Symlinks are resolved BEFORE the
 *  check, so a link out of the vault is rejected rather than followed. */
function contained(root: string, rel: string): string {
  const base = realpathSync(resolve(root));
  const target = resolve(base, rel);
  const real = existsSync(target) ? realpathSync(target) : target;
  if (!within(base, real)) throw new Error(`path escapes the workspace: ${rel}`);
  return real;
}

export function libraryTree(root: string, maxDepth = DEFAULT_DEPTH): LibraryNode[] {
  if (!existsSync(root)) return [];
  const base = realpathSync(resolve(root));

  const walk = (abs: string, rel: string, depth: number): LibraryNode[] => {
    let entries: string[];
    // An unreadable subdirectory is a bad folder, not a bad vault — skip it, keep the tree.
    try { entries = readdirSync(abs); } catch { return []; }
    const nodes: LibraryNode[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        // A link out of the vault must not be listed either — the tree would otherwise leak
        // names and sizes from outside it. Same rule as contained(): resolve, then require.
        // realpathSync throws on a dangling link, which the catch turns into a skip.
        if (lstatSync(childAbs).isSymbolicLink() && !within(base, realpathSync(childAbs))) continue;
        st = statSync(childAbs);
      } catch { continue; }
      const node: LibraryNode = { name, path: childRel, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size };
      if (node.dir && depth < maxDepth) node.children = walk(childAbs, childRel, depth + 1);
      nodes.push(node);
    }
    // Directories first, then files, each alphabetical — a stable shape the UI can rely on.
    return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  };

  return walk(base, "", 1);
}

export function libraryRead(root: string, rel: string): { mime: string; body: Buffer } {
  const abs = contained(root, rel);
  if (!existsSync(abs) || statSync(abs).isDirectory()) throw new Error(`not a file: ${rel}`);
  return { mime: MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", body: readFileSync(abs) };
}
