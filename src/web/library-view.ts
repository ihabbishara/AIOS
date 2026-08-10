// src/web/library-view.ts — pure builders behind /api/library (spec §4). Read-only.
// Containment is the whole risk surface here, so it lives in one function with no HTTP
// around it: resolve the real path (following symlinks) and require it under the root.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { extname, join, parse, relative, resolve, sep } from "node:path";
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

/** Resolve `p` the way the kernel would — segment by segment, following every symlink — but
 *  without requiring it to exist: a tail that is not there stays literal.
 *
 *  resolveReal() alone cannot do this, and the gap is an existence oracle rather than a nicety.
 *  It decides what to resolve with existsSync(), which FOLLOWS links, so any dangling link —
 *  leaf or directory — reads as "not there yet" and its target is never consulted. Containment
 *  then gets judged on where the link sits instead of where it points, and a link out of the
 *  vault answers "escapes" when its target happens to exist and "not a file" when it does not.
 *  Resolving each segment ourselves means `outward/nodir` decides the verdict for
 *  `outward/nodir/x.md` whether or not anything is there. */
const MAX_LINK_HOPS = 8;
function resolveLinks(p: string): string {
  const abs = resolve(p);
  let cur = parse(abs).root;
  let parts = abs.slice(cur.length).split(sep).filter(Boolean);
  for (let hops = 0; parts.length;) {
    const next = join(cur, parts[0]);
    let st;
    // Absent (or unreadable): nothing left to follow, so this and every later segment is literal.
    try { st = lstatSync(next); } catch { cur = next; parts = parts.slice(1); continue; }
    if (!st.isSymbolicLink()) { cur = next; parts = parts.slice(1); continue; }
    // Fail closed rather than hand back a still-unresolved path: past the budget the caller
    // gets an escape, which is what an unresolvable chain has to count as.
    if (++hops > MAX_LINK_HOPS) throw new Error("too many symbolic links");
    const target = resolve(cur, readlinkSync(next));
    const root = parse(target).root;
    parts = [...target.slice(root.length).split(sep).filter(Boolean), ...parts.slice(1)];
    cur = root;
  }
  return cur;
}

/** Resolve `rel` against an already-resolved `base` and prove it stays inside. Symlinks are
 *  resolved BEFORE the check, so a link out of the vault is rejected rather than followed, and
 *  a chain we cannot finish resolving is rejected too. */
function contained(base: string, rel: string): string {
  let real: string;
  try { real = resolveLinks(resolve(base, rel)); }
  catch { throw new Error(`path escapes the workspace: ${rel}`); }
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
        // The name check above is on the UNRESOLVED entry, so a link named like an ordinary
        // file still has to be judged on what it points at: out of the vault leaks names and
        // sizes from outside it, and at a dot-directory it lists `.git` entries the reader
        // then refuses — a tree the UI shows but cannot open. Same rule as libraryRead().
        // statSync throws on a dangling link, which the catch turns into a skip.
        if (lstatSync(childAbs).isSymbolicLink()) {
          const real = resolveLinks(childAbs); // throws on a chain we cannot finish → skipped
          if (!isUnder(real, base) || isHidden(base, real)) continue;
        }
        st = statSync(childAbs);
      } catch { continue; }
      // mtime rides along on the stat we already did — without it the archive can only be
      // sorted by name, and "what changed since I last looked" is unanswerable.
      const node: LibraryNode = {
        name, path: childRel, dir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString(),
      };
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
  const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  // Same disclosure as the missing-root guard, one fs call later: an unreadable file throws
  // EACCES carrying the vault's absolute path, and the endpoint puts that message in the reply.
  try { return { mime, body: readFileSync(abs) }; }
  catch { throw new Error(`cannot read: ${rel}`); }
}
