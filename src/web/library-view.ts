// src/web/library-view.ts — pure builders behind /api/library (spec §4). Read-only.
// Containment is the whole risk surface here, so it lives in one function with no HTTP
// around it: resolve the real path (following symlinks) and require it under the root.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { isUnder, resolveReal } from "../code/paths.js";
import type { LibraryNode } from "./dto.js";

export type { LibraryNode } from "./dto.js";

// `.svg` is deliberately absent. SVG is active content, these files are written by agents, and
// the cockpit serves them from its own origin — image/svg+xml would make an agent-authored file
// stored XSS. It falls through to application/octet-stream, which the view offers as a download.
const MIME: Record<string, string> = {
  ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
  ".json": "application/json", ".csv": "text/csv", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".pdf": "application/pdf",
};

const DEFAULT_DEPTH = 6;
/** Ceiling on any caller's depth. A symlink loop inside the vault amplifies each extra level
 *  into the response, and an unclamped depth never terminates on one. */
const MAX_DEPTH = 16;
/** readFileSync buffers the whole file into the reply — a notes vault has no legitimate read
 *  this large, so refuse rather than allocate. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

/** Hops a symlink chain by hand, bounded. resolveReal() only resolves links whose target
 *  EXISTS; a dangling one keeps the link's own path, so containment would be judged on where
 *  the link sits rather than on where it points. That is an existence oracle: a link out of the
 *  vault answers "escapes" when its target is there and "not a file" when it is not. */
const MAX_LINK_HOPS = 8;
function followLinks(p: string): string {
  let cur = p;
  for (let i = 0; i < MAX_LINK_HOPS; i++) {
    try {
      if (!lstatSync(cur).isSymbolicLink()) break;
      cur = resolve(dirname(cur), readlinkSync(cur));
    } catch { break; } // absent, or a link cycle — whatever we have is what gets checked
  }
  return cur;
}

/** Resolve `rel` against an already-resolved `base` and prove it stays inside. Symlinks are
 *  resolved BEFORE the check, so a link out of the vault is rejected rather than followed. */
function contained(base: string, rel: string): string {
  const real = resolveReal(followLinks(resolve(base, rel)));
  if (!isUnder(real, base)) throw new Error(`path escapes the workspace: ${rel}`);
  return real;
}

/** The tree never lists a dot-leading name, so the reader must not serve one either: an Obsidian
 *  vault is often a git repo, and .env / .git/config live there. Checked segment by segment on
 *  the RESOLVED path, so neither a nested `.git/config` nor an in-vault symlink launders one. */
function isHidden(base: string, real: string): boolean {
  return relative(base, real).split(sep).some((seg) => seg.startsWith("."));
}

export function libraryTree(root: string, maxDepth = DEFAULT_DEPTH): LibraryNode[] {
  if (!existsSync(root)) return [];
  const base = resolveReal(root);
  const cap = Math.min(Math.max(1, maxDepth), MAX_DEPTH);

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
        // statSync throws on a dangling link, which the catch turns into a skip.
        if (lstatSync(childAbs).isSymbolicLink() && !isUnder(childAbs, base)) continue;
        st = statSync(childAbs);
      } catch { continue; }
      const node: LibraryNode = { name, path: childRel, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size };
      if (node.dir && depth < cap) node.children = walk(childAbs, childRel, depth + 1);
      nodes.push(node);
    }
    // Directories first, then files, each alphabetical — a stable shape the UI can rely on.
    return nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  };

  return walk(base, "", 1);
}

export function libraryRead(root: string, rel: string): { mime: string; body: Buffer } {
  // A missing root is the server's problem, not the caller's: without this the fs throw would
  // surface as a 500 carrying the vault's absolute path.
  if (!existsSync(root)) throw new Error("workspace is not available");
  const base = resolveReal(root);
  const abs = contained(base, rel);
  // Before the existence check, so a hidden path answers the same whether or not it is there.
  if (isHidden(base, abs)) throw new Error(`hidden path is not served: ${rel}`);
  if (!existsSync(abs) || statSync(abs).isDirectory()) throw new Error(`not a file: ${rel}`);
  const { size } = statSync(abs);
  if (size > MAX_READ_BYTES) throw new Error(`file too large: ${rel} (${size} bytes, cap ${MAX_READ_BYTES})`);
  return { mime: MIME[extname(abs).toLowerCase()] ?? "application/octet-stream", body: readFileSync(abs) };
}
