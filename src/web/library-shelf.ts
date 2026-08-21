// src/web/library-shelf.ts — pure builder behind /api/library/shelf. Read-only.
//
// The shelf is the Library's front door: what the org has PRODUCED, newest first. The previous
// front door (the wiki's concepts/entities/sources taxonomy) is agent-recall machinery — the
// measured read data shows a human almost never opens it — so the human-facing view is built
// from the two places deliverables actually land: finished goals' folders, and the standalone
// document dirs (reports/, research/, notes/…). Every path returned here is served by
// /api/library/file, which owns containment; this builder only ever lists what readdir shows
// under the resolved vault root.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReal } from "../code/paths.js";
import type { Store, TaskNodeRow } from "../store/db.js";
import { pageTitle } from "./wiki-view.js";
import type { ShelfDoc, ShelfFile, ShelfView, ShelfWork } from "./dto.js";

export type { ShelfView, ShelfWork, ShelfDoc, ShelfFile } from "./dto.js";

/** Standalone-document dirs, by hand. Deliberately NOT discovered: goals/ jobs/ briefs/ daily/
 *  wiki/ memos/ are the org's internal record (drafts, standups, run logs, recall pages), and a
 *  discovered list would quietly promote the next internal dir into the shelf. */
export const DOC_DIRS = ["reports", "research", "notes", "ideas", "finance", "knowledge"] as const;

/** How deep the doc walk goes. finance/idama/ is real nesting; anything deeper is not a shelf. */
const DOC_DEPTH = 2;

/** Enough goals to cover the whole record — the shelf is the history view, so it must not
 *  silently truncate at the operational default of 20. */
const GOAL_LIMIT = 1000;

/**
 * The engine's working residue. Round drafts (`report-a1-v2.md`), critic notes
 * (`report-a1-review-1.md`), refused attempts (`report-a1-denied.md`), fixer/runner rounds —
 * plus the pre-attempt naming (`report-v1.md`, `report-review-1.md`) from before attempts got
 * an `aN` prefix. These are HOW the deliverable got made, not the deliverable; the shelf hides
 * them, the folder in Obsidian keeps them.
 */
const WORKING_FILE = /-(?:a\d+-)?(?:denied|v\d+|review-\d+|fix-\d+|run-\d+)$/i;

export function isWorkingFile(name: string): boolean {
  return WORKING_FILE.test(name.replace(/\.[^.]+$/, ""));
}

/** Plain files in `dir`, vault-relative under `relBase`. Symlinks are skipped outright — the
 *  shelf lists only what verifiably sits in the vault; the file endpoint re-proves containment
 *  on every read anyway, so nothing is lost but a lie. */
function listFiles(dir: string, relBase: string): ShelfFile[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: ShelfFile[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    let st;
    try { st = lstatSync(join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push({ name, path: `${relBase}/${name}`, size: st.size, mtime: st.mtime.toISOString() });
  }
  return out;
}

/** The artifact of the goal's terminal node — the node nothing else depends on, i.e. the file
 *  the plan existed to produce. Several terminals: the one that finished last wins. */
function headlineOf(nodes: TaskNodeRow[]): string | null {
  const depended = new Set(nodes.flatMap((n) => JSON.parse(n.depends_on) as string[]));
  const terminals = nodes
    .filter((n) => !depended.has(n.node_key) && n.artifact && n.status === "done")
    .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""));
  return terminals.at(-1)?.artifact ?? null;
}

function docsIn(base: string, folder: string, rel: string, depth: number): ShelfDoc[] {
  const abs = join(base, rel);
  const out: ShelfDoc[] = [];
  for (const f of listFiles(abs, rel)) {
    let title = f.name.replace(/\.md$/i, "");
    if (/\.md$/i.test(f.name)) {
      // Title from the doc itself — a shelf of raw slugs is the archive all over again.
      try { title = pageTitle(readFileSync(join(base, f.path), "utf8"), title); } catch { /* name stands */ }
    }
    out.push({ folder, name: f.name, path: f.path, title, size: f.size, mtime: f.mtime });
  }
  if (depth < DOC_DEPTH) {
    let entries: string[] = [];
    try { entries = readdirSync(abs); } catch { /* unreadable dir: its absence is the answer */ }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      try { if (!lstatSync(join(abs, name)).isDirectory()) continue; } catch { continue; }
      out.push(...docsIn(base, folder, `${rel}/${name}`, depth + 1));
    }
  }
  return out;
}

export function buildLibraryShelf(store: Store, vaultRoot: string): ShelfView {
  if (!existsSync(vaultRoot)) return { works: [], docs: [] };
  const base = resolveReal(vaultRoot);

  const works: ShelfWork[] = [];
  for (const g of store.listGoals(GOAL_LIMIT)) {
    // Running/queued goals belong to the Goals view; the shelf is the record of finished work.
    if (!g.goal_dir || (g.status !== "done" && g.status !== "failed" && g.status !== "abandoned")) continue;
    const files = listFiles(join(base, "goals", g.goal_dir), `goals/${g.goal_dir}`)
      // goal.md is the brief — the ask, not the output. The goal detail view owns it.
      .filter((f) => f.name !== "goal.md" && !isWorkingFile(f.name))
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    if (files.length === 0) continue; // nothing produced, nothing shelved
    const headline = headlineOf(store.listNodes(g.id));
    works.push({
      id: g.id, slug: g.slug, title: g.title, department: g.department, lead: g.lead,
      status: g.status, finishedAt: g.updated_at,
      // A headline the folder no longer holds (renamed, cleaned up) must not dangle in the UI.
      headline: headline && files.some((f) => f.name === headline) ? headline : null,
      files,
    });
  }
  works.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));

  const docs = DOC_DIRS.flatMap((d) => docsIn(base, d, d, 1))
    .sort((a, b) => b.mtime.localeCompare(a.mtime));

  return { works, docs };
}
