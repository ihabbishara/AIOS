// src/vault/wiki-schema.ts — the LLM Wiki scaffold every install is provisioned with.
//
// AIOS writes a lot and reads almost none of it back. Measured on a 903-document
// install: 71.5% of vault documents are per-run pipeline artifacts, and of 324
// recall hits, 308 (95.1%) landed on the 22 hand-synthesized files in knowledge/.
// jobs/ (162 docs) had never been retrieved once. A pile is not a knowledge base.
//
// These seeds add the missing layer: a wiki the org maintains ON TOP of its own
// output, so knowledge compounds instead of being re-derived per run.
//
// Seeded ONCE, never overwritten — see VaultWriter.init(). After the first boot
// these files belong to the wiki maintainer and the user, not to this module.

/** Created empty at init so the maintainer never has to guess the layout. */
export const WIKI_DIRS = [
  "wiki/sources",
  "wiki/entities",
  "wiki/concepts",
  "wiki/topics",
  "wiki/analyses",
] as const;

const SCHEMA = `# AIOS Wiki — Schema

This directory is an **LLM Wiki**: a knowledge base the org incrementally builds and
maintains. AIOS produces the record; the wiki is what that record *means*.

**The wiki is a compounding artifact.** Every ingest enriches existing pages. Every
good answer is filed back. Nothing is re-derived that has already been understood.

---

## 1. Architecture

Two layers, plus the schema files that discipline the maintainer.

| Layer | Path | Purpose | Mutability |
|---|---|---|---|
| **The record** | \`briefs/ goals/ daily/ knowledge/ notes/ memos/ reports/ research/ finance/ ideas/\` | What the org did and found — machine-written, timestamped | **Immutable.** Read it; never edit or delete it. |
| **The wiki** | \`wiki/\` | Atemporal knowledge that compounds across runs | Maintainer creates, edits and refactors freely. |
| **Schema** | \`CLAUDE.md\`, \`index.md\`, \`log.md\` | Configuration and navigation | Co-evolved with the user. |

**Invariants:**
- **Never modify the record.** If a run produced something wrong, note that in the wiki.
  The record is history and history does not get rewritten.
- **Never write outside this directory.** The vault above it belongs to the user. AIOS
  owns this folder and nothing else.
- The record is *sources*; the wiki is *understanding*. Do not confuse the two.

---

## 2. Folder map

\`\`\`
AIOS/
├── CLAUDE.md          # this file — schema
├── index.md           # wiki catalog — read this first when answering
├── log.md             # append-only timeline
│
│   # ---- the record (immutable, machine-written) ----
├── briefs/            # morning/evening briefs
├── goals/             # one folder per goal run: plan, artifacts, report
├── daily/             # daily notes
├── knowledge/         # research syntheses produced by goal runs
├── notes/ memos/      # working notes; per-domain memo state
├── reports/ research/ finance/ ideas/
│
│   # ---- the wiki (maintained) ----
└── wiki/
    ├── sources/       # one page per ingested item from the record
    ├── entities/      # people, organizations, places, products, systems
    ├── concepts/      # ideas, frameworks, theories, terms
    ├── topics/        # synthesis spanning many sources — where the value is
    └── analyses/      # filed answers: comparisons, decks, charts
\`\`\`

---

## 3. Page conventions

### Naming
- **Title Case** with spaces: \`wiki/entities/Vannevar Bush.md\`, not \`vannevar-bush.md\`.
- Match the canonical name used in the world. Disambiguate with parens when needed.
- Source pages mirror the record path: \`knowledge/algeria-agri-food.md\` →
  \`wiki/sources/algeria-agri-food.md\`.

### Frontmatter
Every page starts with YAML so Dataview queries work:

\`\`\`yaml
---
type: entity | concept | topic | source | analysis
tags: [tag1, tag2]
created: 2026-01-31
updated: 2026-01-31
sources: ["[[source-page-1]]"]        # entity/concept/topic
record_path: knowledge/foo.md          # source pages only
---
\`\`\`

Update \`updated\` whenever the page is touched. \`sources\` lists every contributor.

### Body structure (suggested, not rigid)
- **Source** — link to the record file, TL;DR (3–5 bullets), key claims, entities and
  concepts referenced, open questions.
- **Entity** — one-line definition, key facts (dated), relationships, where it appears.
- **Concept** — definition, origin, examples and anti-examples, related concepts.
- **Topic** — thesis (the current synthesis), evidence for and against with citations,
  open questions. Topic pages drift fastest; keep \`updated\` honest.

### Linking
- Inside the wiki use \`[[Page Name]]\`. Wikilinks survive renames and build the graph.
- **NEVER wrap a wikilink across a line break.** \`[[Some Long Page\\nName]]\` does not
  resolve — it renders as literal text and the link is silently lost. Let the line run long.
- To the record, use a relative markdown link: \`[run report](../goals/2026-01-31-x/report.md)\`.

### Contradictions
When new material contradicts an existing claim, **do not silently overwrite.** Add a
"Contradictions" section, cite both, and raise it with the user to adjudicate.

---

## 4. Workflows

### 4a. Ingest
1. **Read** the record file in full.
2. **Write a source page** at \`wiki/sources/<name>.md\`.
3. **Touch related pages** — create or update each entity and concept. A real ingest
   touches 5–15 pages. If it touched one, the synthesis was skipped.
4. **Update topics** the material bears on.
5. **Flag contradictions** on the page and to the user.
6. **Update \`index.md\`** and **append to \`log.md\`**.

**Do not create one wiki page per run artifact.** Most of the record is routine and
belongs in no page at all. The wiki earns its keep by synthesizing ACROSS runs: when
many runs bear on one subject, that is a topic page, not fifty source pages. A single
project has been observed spanning 14 differently-named goal folders and a third of a
vault's total text — the wiki's job is to make that one navigable subject.

### 4b. Query
1. **Read \`index.md\` first**, then the pages it points to.
2. Synthesize with wikilinks back to supporting pages.
3. **File non-trivial answers** to \`wiki/analyses/<name>.md\` — this is how exploration
   compounds instead of evaporating into chat.
4. Log the query if something was filed.

### 4c. Lint (on request)
Report, don't auto-fix: contradictions; stale claims; orphan pages (no inbound links);
concepts mentioned but never promoted to a page; missing cross-references; coverage
gaps; suggested follow-ups. Propose, then act on what the user selects.

---

## 5. \`index.md\`

Content-oriented catalog, by category, updated on every ingest. Each entry is a
wikilink, a one-line hook, and optional metadata. It is a table of contents, not a
summary — keep entries to one line.

---

## 6. \`log.md\`

Append-only. **Standard prefix so unix tools can parse it:**

\`\`\`markdown
## [2026-01-31] ingest | Algeria agri-food market analysis
- Created \`wiki/sources/algeria-agri-food.md\`
- Updated [[Algeria]], [[Couscous]], [[EU Import Tariffs]]
- Updated \`index.md\`
\`\`\`

Entry types: \`ingest\`, \`query\`, \`lint\`, \`refactor\`, \`note\`.
Recent history: \`grep "^## \\[" log.md | tail -10\`.

---

## 7. Operating rules

- **Never modify the record. Never write outside this directory.**
- **Always update \`index.md\` and \`log.md\`** on ingest or a filed query.
- **Always update \`updated:\`** on pages touched.
- **Prefer a wiki page over a long chat answer** when the synthesis has reuse value.
- **Stay disciplined about wikilinks.** No inbound links is an orphan; no outbound links
  is a dead end. Both are bugs.
- **Surface contradictions immediately.**
- **Confirm before destructive refactors** — renaming a heavily-linked page, merging
  entities, deleting pages.
- **Date all dates.** Convert "last week" to an absolute ISO date.

---

## 8. Co-evolution

This file is not frozen. As conventions prove themselves, update §3, §4 and §5/§6 with
the user. Log every change as a \`refactor\` entry and bring old pages into compliance
opportunistically.
`;

const INDEX = `# Index

Content catalog of the wiki. Updated on every ingest. **Read this first when answering
a question**, then drill into the pages it points to.

> Format: \`[[link]] — one-line hook\` (+ optional metadata). Conventions: see \`CLAUDE.md\`.

---

## Sources

*(empty — one page per ingested item from the record)*

## Entities

*(empty — people, organizations, places, products, systems)*

## Concepts

*(empty — ideas, frameworks, theories, terms)*

## Topics

*(empty — synthesis pages appear once 2+ sources bear on the same subject)*

## Analyses

*(empty — filed query results land here as \`wiki/analyses/<name>.md\`)*
`;

const log = (date: string): string => `# Log

Append-only chronological record. Standard prefix: \`## [YYYY-MM-DD] type | title\`.
Entry types: \`ingest\`, \`query\`, \`lint\`, \`refactor\`, \`note\`.

Recent history: \`grep "^## \\[" log.md | tail -10\`.

---

## [${date}] note | Wiki initialized
- Scaffolded \`CLAUDE.md\` (schema), \`index.md\` (catalog), \`log.md\` (this file).
- Created \`wiki/{sources,entities,concepts,topics,analyses}\`.
- The record (\`briefs/\`, \`goals/\`, \`daily/\`, \`knowledge/\`, …) is the source layer and
  is immutable. Nothing in it has been read or ingested yet.
`;

/** Seeded once at init, keyed by path relative to the AIOS vault root. */
export function seedFiles(date: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["CLAUDE.md", SCHEMA],
    ["index.md", INDEX],
    ["log.md", log(date)],
  ];
}
