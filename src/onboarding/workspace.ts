// src/onboarding/workspace.ts — workspace choice → a resolved vault path (spec §2).
// Pure: no filesystem access. The endpoint owns the writability probe, which is what
// lets every branch here be tested without a temp dir.
import { isAbsolute, join, normalize } from "node:path";

export interface WorkspaceChoice { mode: "builtin" | "custom"; path?: string; subdir?: string }
export type WorkspaceResult =
  | { ok: true; path: string; subdir: string; warning?: string }
  | { ok: false; error: string };

/** Directories a sync client rewrites underneath us. Warn, never block — it is the user's disk. */
export const SYNC_HINTS = /(?:Library\/Mobile Documents|iCloud|Dropbox|Google Drive|OneDrive)/i;

const DEFAULT_SUBDIR = "AIOS";

export function resolveWorkspace(choice: WorkspaceChoice, home: string): WorkspaceResult {
  const subdirRaw = (choice.subdir ?? "").trim();
  const subdir = subdirRaw || DEFAULT_SUBDIR;
  // A subdir is joined onto the vault root, so anything with a separator or a dot-dot
  // segment escapes it. One plain folder name is the whole contract.
  if (subdir !== normalize(subdir) || /[\\/]/.test(subdir) || subdir === "..") {
    return { ok: false, error: "subdir must be a single folder name" };
  }

  if (choice.mode === "builtin") {
    return { ok: true, path: join(home, "AIOS", "workspace"), subdir };
  }

  const raw = (choice.path ?? "").trim();
  if (!raw) return { ok: false, error: "a workspace path is required" };
  const path = raw.startsWith("~") ? join(home, raw.slice(1)) : raw;
  if (!isAbsolute(path)) return { ok: false, error: "workspace path must be absolute or start with ~" };

  return SYNC_HINTS.test(path)
    ? { ok: true, path, subdir, warning: "This folder looks like it is cloud-synced. Sync clients rewrite files underneath the daemon, which can corrupt artifacts mid-write." }
    : { ok: true, path, subdir };
}
