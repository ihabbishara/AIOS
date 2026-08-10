// ui2/src/lib/markdown.tsx — markdown-lite for chat bubbles and wiki pages. Safe subset
// rendered as React nodes (never innerHTML): paragraphs, **bold**, `code`, ``` fences,
// -/1. lists, ### headings, [text](http…) links. Anything else stays literal text — unknown
// syntax can't break rendering.
import type { ReactNode } from "react";

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
/** A page-relative markdown link — `[record](../../knowledge/x.md)`. The wiki schema prescribes
 *  exactly this for pointing at the record, so the reading room has to follow one; without a
 *  handler it stays literal text, which is what chat wants. Only ./ and ../ prefixes qualify,
 *  so `[x](/etc/passwd)` and bare words are never linkified. */
const RELLINK = /\[([^\]]+)\]\((\.\.?\/[^\s)]+)\)/;
/** `[[Page]]` / `[[Page|alias]]`. Newline-intolerant on purpose, matching the wiki schema and
 *  src/web/wiki-view.ts: a link wrapped across a break does not resolve, so it must render as
 *  the literal text it is rather than as a working link the graph doesn't contain. */
const WIKILINK = /\[\[([^\]\n]+)\]\]/;

export interface MarkdownLinks {
  /** `[[Page]]` → the page name. Absent in chat, where wikilinks stay literal. */
  onWikiLink?: (page: string) => void;
  /** `[text](../rel/path)` → the raw relative href, for the caller to resolve. */
  onRelLink?: (href: string) => void;
}

function inline(text: string, links?: MarkdownLinks): ReactNode[] {
  const { onWikiLink, onRelLink } = links ?? {};
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest.length > 0) {
    const code = rest.match(/`([^`]+)`/);
    const bold = rest.match(/\*\*([^*]+)\*\*/);
    const link = rest.match(LINK);
    // Only offered when a handler exists, so chat bubbles keep rendering these literally.
    const wiki = onWikiLink ? rest.match(WIKILINK) : null;
    const rel = onRelLink ? rest.match(RELLINK) : null;
    const first = [code, bold, link, wiki, rel]
      .filter((m): m is RegExpMatchArray => m != null && m.index != null)
      .sort((a, b) => a.index! - b.index!)[0];
    if (!first) { out.push(rest); break; }
    if (first.index! > 0) out.push(rest.slice(0, first.index));
    if (first === code) out.push(<code key={k++} className="font-mono text-[12px] bg-bg border border-line rounded px-1">{first[1]}</code>);
    // Bold recurses: its inner text can carry a link, a code span or a [[wikilink]], and pushing
    // it as a raw string left those literal. On the live wiki that swallowed 136 wikilinks
    // across 66 of 202 pages — a third of the wiki had dead text where an edge should be.
    // The bold pattern is `[^*]+`, so the inner text can never contain another `**` and this
    // cannot recurse indefinitely.
    else if (first === bold) out.push(<strong key={k++} className="text-strong font-semibold">{inline(first[1], links)}</strong>);
    else if (first === rel) {
      // Same reasoning as a wikilink: a button keeps navigation in-app, and the href is handed
      // to the caller raw so path resolution lives with the page that knows its own directory.
      const href = first[2];
      out.push(<button key={k++} type="button" onClick={() => onRelLink!(href)}
        className="text-info underline underline-offset-2 decoration-dotted hover:decoration-solid">{first[1]}</button>);
    }
    else if (first === wiki) {
      const [target, alias] = first[1].split("|");
      const page = target.trim();
      // A button, not an <a>: navigation stays in-app and the doctrine's "only http(s) links
      // link" rule holds. An in-page [[#anchor]] is not a page, so it stays literal text.
      out.push(page.startsWith("#")
        ? <span key={k++}>{first[0]}</span>
        : <button key={k++} type="button" onClick={() => onWikiLink!(page)}
            className="text-info underline underline-offset-2 decoration-dotted hover:decoration-solid">
            {(alias ?? target).trim()}
          </button>);
    }
    else out.push(<a key={k++} href={first[2]} target="_blank" rel="noreferrer" className="text-info underline underline-offset-2">{first[1]}</a>);
    rest = rest.slice(first.index! + first[0].length);
  }
  return out;
}

/**
 * Rejoin soft-wrapped prose into logical lines — real markdown paragraph behaviour, where
 * consecutive non-blank lines are one paragraph and a blank line separates.
 *
 * Opt-in, because the two callers want opposite things. The wiki is wrapped at ~100 chars, and
 * rendering one <div> per raw line broke 414 list-item continuations across 75 of 202 pages and
 * split 177 `**bold**` spans across a newline, which then rendered as literal asterisks. Chat is
 * the opposite case: there a line break is authored meaning ("done / today / blockers" belongs
 * on three lines), so joining would be the bug.
 */
function rejoinSoftWraps(lines: string[]): string[] {
  const out: string[] = [];
  // Whether the previous logical line can absorb a continuation. A blank ends the block, and an
  // ATX heading ends at its own newline — without that, the line after `# H` joins the heading.
  let joinable = false;
  for (const line of lines) {
    const blank = line.trim() === "";
    const isList = /^\s*(?:[-*]|\d+[.)])\s+/.test(line);
    const isHeading = /^#{1,3}\s+/.test(line);
    if (joinable && !blank && !isList && !isHeading) {
      out[out.length - 1] = `${out[out.length - 1].replace(/\s+$/, "")} ${line.trim()}`;
      continue;
    }
    out.push(line);
    joinable = !blank && !isHeading;
  }
  return out;
}

export function Markdown(
  { text, onWikiLink, onRelLink, softWrap }: { text: string; softWrap?: boolean } & MarkdownLinks,
) {
  const links: MarkdownLinks = { onWikiLink, onRelLink };
  const blocks: ReactNode[] = [];
  // Fences first — their content renders verbatim, untouched by inline/list parsing.
  const parts = text.split(/```(?:\w*\n)?/);
  let k = 0;
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      blocks.push(<pre key={k++} className="font-mono text-[11.5px] bg-bg border border-line rounded-md p-2.5 my-1.5 overflow-x-auto whitespace-pre-wrap">{part.replace(/\n$/, "")}</pre>);
      return;
    }
    // Fences were split out above, so rejoining can never touch verbatim code.
    const lines = softWrap ? rejoinSoftWraps(part.split("\n")) : part.split("\n");
    let list: { ordered: boolean; items: ReactNode[] } | null = null;
    const flush = () => {
      if (!list) return;
      const items = list.items.map((it, j) => <li key={j}>{it}</li>);
      blocks.push(list.ordered
        ? <ol key={k++} className="list-decimal pl-5 my-1 flex flex-col gap-0.5">{items}</ol>
        : <ul key={k++} className="list-disc pl-5 my-1 flex flex-col gap-0.5">{items}</ul>);
      list = null;
    };
    for (const line of lines) {
      const li = line.match(/^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/);
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (li) {
        const ordered = li[1] != null;
        if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
        list.items.push(inline(li[2], links));
      } else if (h) {
        flush();
        blocks.push(<div key={k++} className="text-strong font-semibold mt-1.5 mb-0.5">{inline(h[2], links)}</div>);
      } else if (line.trim() === "") {
        flush();
      } else {
        flush();
        blocks.push(<div key={k++}>{inline(line, links)}</div>);
      }
    }
    flush();
  });
  return <div className="flex flex-col gap-1">{blocks}</div>;
}
