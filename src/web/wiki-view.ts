// src/web/wiki-view.ts — pure builders behind /api/library/wiki and /api/library/search.
//
// The Library is the wiki's reading room. That choice is measured, not aesthetic: of 669
// record files, goals/ + jobs/ + briefs/ are 575 of them (86%) and recall data showed they are
// almost never read — jobs/ (162 docs) not once — while 308 of 324 hits landed on the 22
// hand-written knowledge/ files. The wiki is the layer built ON TOP of that record, and it is
// what a human should meet first. The record stays fully reachable; it is just not the front door.
//
// Everything here is read-only and derives from the files themselves, so a wiki edited directly
// in Obsidian reads back identically — there is no second source of truth to drift.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveReal } from "../code/paths.js";
import { recall } from "../memory/recall.js";
import type { Store } from "../store/db.js";
import type { LibrarySearchHit, WikiBrokenLink, WikiPageView, WikiSectionView, WikiView } from "./dto.js";

export type { WikiView, WikiPageView, LibrarySearchHit } from "./dto.js";

/** The wiki's own subdirectory inside the vault subdir AIOS owns. */
export const WIKI_DIR = "wiki";

/**
 * `[[Page Name]]`, deliberately refusing to match across a newline.
 *
 * The wiki schema forbids wrapping a wikilink over a line break because such a link does not
 * resolve — it renders as literal text and the edge is silently lost. A parser that accepted
 * `[[Some Long Page\nName]]` would report a healthy graph the renderer cannot reproduce, so it
 * has to fail exactly where the real one does. Validated against the live wiki: 3274 links,
 * 3273 resolved, the one remainder an intra-page `[[#anchor]]` (see below).
 */
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;

const FRONTMATTER = /^---\n([\s\S]*?)\n---/;
const HEADING = /^#\s+(.+)$/m;

/** Link targets of the `[[Page]]` form, deduped and in first-appearance order.
 *  `[[Page|alias]]` resolves on the part before the pipe; `[[#anchor]]` is an intra-page
 *  reference, not an edge, and is dropped rather than counted as broken. */
export function parseWikilinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(WIKILINK)) {
    const target = m[1].split("|")[0].trim();
    if (!target || target.startsWith("#")) continue;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}

/** The frontmatter `type:` value, or null. Deliberately shallow — one scalar off the top of the
 *  file, not a YAML parse, because a malformed page must still be readable. */
export function frontmatterType(body: string): string | null {
  const fm = FRONTMATTER.exec(body);
  if (!fm) return null;
  const line = /^type:\s*(.+)$/m.exec(fm[1]);
  return line ? line[1].trim().replace(/^["']|["']$/g, "") || null : null;
}

/** First `# ` heading, falling back to the page name. Frontmatter is stripped first so a
 *  `# ` inside it can never be mistaken for the title. */
export function pageTitle(body: string, fallback: string): string {
  const h = HEADING.exec(body.replace(FRONTMATTER, ""));
  return h ? h[1].trim() : fallback;
}

interface RawPage { name: string; path: string; section: string; body: string; updated: string }

function readSection(wikiAbs: string, section: string): RawPage[] {
  const dir = join(wikiAbs, section);
  let entries: string[];
  // An unreadable section is a bad folder, not a bad wiki — skip it and keep the rest.
  try { entries = readdirSync(dir); } catch { return []; }
  const pages: RawPage[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md") || file.startsWith(".")) continue;
    const abs = join(dir, file);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      pages.push({
        name: file.slice(0, -3),
        path: `${WIKI_DIR}/${section}/${file}`,
        section,
        body: readFileSync(abs, "utf8"),
        updated: st.mtime.toISOString(),
      });
    } catch { continue; } // a file that vanished mid-walk is not a reason to fail the view
  }
  return pages;
}

/**
 * The whole wiki: sections, pages, and the link graph in both directions.
 *
 * Backlinks are computed here rather than in the client because they need every page at once —
 * the reader only ever holds one. Orphans (no inbound) and dead ends (no outbound) are both
 * bugs by the schema, so the totals report them instead of letting them accumulate unseen.
 */
export function buildWikiView(vaultRoot: string): WikiView {
  const empty: WikiView = {
    sections: [], index: null, log: null,
    totals: { pages: 0, links: 0, orphans: 0, deadEnds: 0 }, broken: [],
  };
  if (!existsSync(vaultRoot)) return empty;
  const base = resolveReal(vaultRoot);
  const wikiAbs = join(base, WIKI_DIR);
  if (!existsSync(wikiAbs)) return empty;

  // Section order is discovered, not hardcoded: the schema may add one (analyses/ is currently
  // empty but real), and a hardcoded list would silently hide it.
  let sectionNames: string[];
  try {
    sectionNames = readdirSync(wikiAbs)
      .filter((n) => !n.startsWith(".") && statSync(join(wikiAbs, n)).isDirectory())
      .sort();
  } catch { return empty; }

  const raw = sectionNames.flatMap((s) => readSection(wikiAbs, s));
  const byName = new Map(raw.map((p) => [p.name, p]));

  const outbound = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  const broken: WikiBrokenLink[] = [];
  let links = 0;

  for (const page of raw) {
    const targets = parseWikilinks(page.body);
    const resolved: string[] = [];
    for (const t of targets) {
      links++;
      // A self-link is not an edge — it would make every page its own backlink.
      if (t === page.name) continue;
      if (!byName.has(t)) { broken.push({ from: page.name, link: t }); continue; }
      resolved.push(t);
      const back = backlinks.get(t);
      if (back) back.push(page.name);
      else backlinks.set(t, [page.name]);
    }
    outbound.set(page.name, resolved);
  }

  const sections: WikiSectionView[] = sectionNames.map((name) => ({
    name,
    pages: raw
      .filter((p) => p.section === name)
      .map((p): WikiPageView => ({
        name: p.name,
        path: p.path,
        section: p.section,
        title: pageTitle(p.body, p.name),
        type: frontmatterType(p.body),
        updated: p.updated,
        outbound: outbound.get(p.name) ?? [],
        backlinks: (backlinks.get(p.name) ?? []).slice().sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));

  const all = sections.flatMap((s) => s.pages);
  const has = (rel: string) => (existsSync(join(base, rel)) ? rel : null);

  return {
    sections,
    index: has("index.md"),
    log: has("log.md"),
    totals: {
      pages: all.length,
      links,
      orphans: all.filter((p) => p.backlinks.length === 0).length,
      deadEnds: all.filter((p) => p.outbound.length === 0).length,
    },
    broken,
  };
}

/** recall() caps at MAX_LIMIT=20, and the vault filter below runs after that slice, so a query
 *  matching many mail/event/decision docs returns fewer than `limit` vault hits rather than
 *  reaching deeper. Acceptable here: 849 of 1178 indexed docs are vault files. */
export const SEARCH_LIMIT = 20;

/**
 * Search the library. Thin wrapper over the memory index the agents already use — the same
 * BM25 + entity expansion, over the same 849 indexed vault documents, keyed by `ref`, which
 * IS the vault-relative path /api/library/file serves. No new index, no second crawl.
 *
 * `logUse: false` is the load-bearing argument: a human browsing must not write `memory_use`
 * rows or refresh `last_retrieved_at`. Those are the evidence base for what the ORG reads and
 * the input to the stale penalty; counting cockpit searches as agent reads would corrupt the
 * very measurement that justified building the wiki.
 */
export function searchLibrary(store: Store, query: string, limit = SEARCH_LIMIT): LibrarySearchHit[] {
  if (!query.trim()) return [];
  return recall(store, query, { limit, logUse: false })
    .filter((h) => h.source === "vault")
    .map((h) => ({
      path: h.ref,
      // The basename is the display name everywhere else in the Library, and for a wiki page it
      // is also exactly what `[[links]]` resolve on — so a hit reads the same as the tree entry.
      title: (h.ref.split("/").pop() ?? h.ref).replace(/\.md$/, ""),
      snippet: h.snippet,
      score: h.score,
      ts: h.ts,
      wiki: h.ref.startsWith(`${WIKI_DIR}/`),
    }));
}
