// src/onboarding/workspace.ts — workspace choice → a resolved vault path (spec §2).
// Pure: no filesystem access. The endpoint owns the writability probe, which is what
// lets every branch here be tested without a temp dir.
import { isAbsolute, join } from "node:path";

export interface WorkspaceChoice { mode: "builtin" | "custom"; path?: string; subdir?: string }
/** On success `warning` is absent entirely, never `undefined` — treat missing and undefined alike. */
export type WorkspaceResult =
  | { ok: true; path: string; subdir: string; warning?: string }
  | { ok: false; error: string };

/** Directories a sync client rewrites underneath us. Warn, never block — it is the user's disk.
 *  `Library/CloudStorage` is where macOS mounts Google Drive, Box and friends since Ventura;
 *  its `GoogleDrive-<account>` form has no space, so the `Google Drive` alternative misses it.
 *  Matching is deliberately unanchored: a false positive costs one dismissable warning. */
export const SYNC_HINTS = /(?:Library\/Mobile Documents|Library\/CloudStorage|iCloud|Dropbox|Google Drive|OneDrive)/i;

const DEFAULT_SUBDIR = "AIOS";
/** A subdir is one plain folder name joined onto the vault root. Allowlist, not denylist:
 *  a denylist of separators and dot-dot admits ".", "~", and a NUL byte, which respectively
 *  land on the vault root, make a folder that is a shell footgun, and throw inside mkdir.
 *  The first character must be a letter or digit in any script, which is the clause doing the
 *  work — it excludes every dot-segment by construction while still allowing メモ or Übersicht.
 *  The trailing class also admits combining marks, because macOS normalizes filenames to NFD:
 *  a name pasted from a Finder or shell path arrives decomposed, so "Ü" reaches us as a plain
 *  "U" followed by a separate combining diaeresis. A mark can still never lead. */
const SUBDIR_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]*$/u;

export function resolveWorkspace(choice: WorkspaceChoice, home: string): WorkspaceResult {
  const subdirRaw = (choice.subdir ?? "").trim();
  const subdir = subdirRaw || DEFAULT_SUBDIR;
  if (!SUBDIR_RE.test(subdir)) {
    return { ok: false, error: "subdir must be a single folder name" };
  }

  // No sync check here: the builtin path is derived from `home` rather than chosen, so warning
  // about it would fire on a redirected profile the user cannot act on from this screen.
  if (choice.mode === "builtin") {
    return { ok: true, path: join(home, "AIOS", "workspace"), subdir };
  }

  const raw = (choice.path ?? "").trim();
  if (!raw) return { ok: false, error: "a workspace path is required" };
  let path: string;
  if (raw === "~") path = home;
  else if (raw.startsWith("~/")) path = join(home, raw.slice(2));
  // ~user/foo is another user's home, which we cannot resolve — inventing a path under OUR
  // home is worse than refusing, because it silently succeeds on the wrong directory.
  else if (raw.startsWith("~")) return { ok: false, error: "only ~/ is supported — write the full path instead" };
  else path = raw;
  if (!isAbsolute(path)) return { ok: false, error: "workspace path must be absolute or start with ~" };

  return SYNC_HINTS.test(path)
    ? { ok: true, path, subdir, warning: "This folder looks like it is cloud-synced. Sync clients rewrite files underneath the daemon, which can corrupt artifacts mid-write." }
    : { ok: true, path, subdir };
}
