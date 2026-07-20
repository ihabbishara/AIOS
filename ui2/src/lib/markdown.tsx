// ui2/src/lib/markdown.tsx — markdown-lite for chat bubbles. Safe subset rendered as React
// nodes (never innerHTML): paragraphs, **bold**, `code`, ``` fences, -/1. lists, ### headings,
// [text](http…) links. Anything else stays literal text — unknown syntax can't break rendering.
import type { ReactNode } from "react";

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest.length > 0) {
    const code = rest.match(/`([^`]+)`/);
    const bold = rest.match(/\*\*([^*]+)\*\*/);
    const link = rest.match(LINK);
    const first = [code, bold, link]
      .filter((m): m is RegExpMatchArray => m != null && m.index != null)
      .sort((a, b) => a.index! - b.index!)[0];
    if (!first) { out.push(rest); break; }
    if (first.index! > 0) out.push(rest.slice(0, first.index));
    if (first === code) out.push(<code key={k++} className="font-mono text-[12px] bg-bg border border-line rounded px-1">{first[1]}</code>);
    else if (first === bold) out.push(<strong key={k++} className="text-strong font-semibold">{first[1]}</strong>);
    else out.push(<a key={k++} href={first[2]} target="_blank" rel="noreferrer" className="text-info underline underline-offset-2">{first[1]}</a>);
    rest = rest.slice(first.index! + first[0].length);
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  // Fences first — their content renders verbatim, untouched by inline/list parsing.
  const parts = text.split(/```(?:\w*\n)?/);
  let k = 0;
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      blocks.push(<pre key={k++} className="font-mono text-[11.5px] bg-bg border border-line rounded-md p-2.5 my-1.5 overflow-x-auto whitespace-pre-wrap">{part.replace(/\n$/, "")}</pre>);
      return;
    }
    const lines = part.split("\n");
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
        list.items.push(inline(li[2]));
      } else if (h) {
        flush();
        blocks.push(<div key={k++} className="text-strong font-semibold mt-1.5 mb-0.5">{inline(h[2])}</div>);
      } else if (line.trim() === "") {
        flush();
      } else {
        flush();
        blocks.push(<div key={k++}>{inline(line)}</div>);
      }
    }
    flush();
  });
  return <div className="flex flex-col gap-1">{blocks}</div>;
}
