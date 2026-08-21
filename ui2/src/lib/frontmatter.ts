// ui2/src/lib/frontmatter.ts — vault artifacts open with a YAML frontmatter block (created,
// goal, node, role, critic objections…). CommonMark has no idea what that is: the closing
// `---` turns everything above it into a giant setext H2, so a document's first screen was one
// massive bold heading of provenance metadata (observed live 2026-08-21). Split it off before
// rendering: the body is the document, the metadata is a quiet collapsible strip.
//
// Deliberately not a YAML parser — vault frontmatter is flat `key: value`/`key: "value"`
// lines. Anything that doesn't look like that folds into the previous value, and a block
// that never closes is treated as ordinary content rather than guessed at.

export interface Frontmatter {
  meta: Array<{ key: string; value: string }> | null;
  body: string;
}

export function splitFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---\n")) return { meta: null, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { meta: null, body: content };
  const block = content.slice(4, end);
  const body = content.slice(end + 4).replace(/^\n+/, "");
  const meta: Array<{ key: string; value: string }> = [];
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      meta.push({ key: m[1], value: unquote(m[2]) });
    } else if (meta.length && line.trim()) {
      meta[meta.length - 1].value += ` ${unquote(line.trim())}`;
    }
  }
  return meta.length ? { meta, body } : { meta: null, body: content };
}

function unquote(v: string): string {
  return v.length > 1 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}
