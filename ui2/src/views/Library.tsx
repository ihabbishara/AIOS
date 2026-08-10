// ui2/src/views/Library.tsx — the wiki's reading room, with the record kept as an archive.
//
// The split is measured, not aesthetic: goals/ + jobs/ + briefs/ are 86% of the record's files
// and recall showed they are almost never read (jobs/, 162 docs, not once), while 308 of 324
// hits landed on the 22 hand-written knowledge/ files. The wiki is the layer built on top of
// that record — so it is the front door, and the record is one segment away, never hidden.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type LibraryNode, type WikiView, type WikiPageView, type LibrarySearchHit } from "../api.js";
import { Empty, PageHeader, SectionLabel, Tag } from "../components/ui.js";
import { Markdown } from "../lib/markdown.js";

const isText = (p: string) => /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(p);
// `.svg` is absent on purpose: SVG is active content, the server refuses to type it as an image,
// and it belongs on the download path rather than in an element this origin renders.
const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
const isPdf = (p: string) => /\.pdf$/i.test(p);
const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);

/** Frontmatter is metadata, not prose — the reader shows `type` and `updated` as chips instead
 *  of dumping raw YAML at the top of every page. Its `sources: [[...]]` links are not lost:
 *  they are already counted in the page's outbound list. */
const stripFrontmatter = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, "");

const dayOf = (iso: string) => iso.slice(0, 10);

function Tree({ nodes, onPick, active }: {
  nodes: LibraryNode[]; onPick: (p: string) => void; active: string;
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {nodes.map((n) => (
        <li key={n.path}>
          {n.dir ? (
            <details open>
              <summary className="cursor-pointer text-dim hover:text-fg">{n.name}</summary>
              <div className="pl-3 border-l border-line ml-1 mt-0.5">
                {n.children && <Tree nodes={n.children} onPick={onPick} active={active} />}
              </div>
            </details>
          ) : (
            <button onClick={() => onPick(n.path)}
              className={`text-left w-full truncate ${n.path === active ? "text-strong" : "text-dim hover:text-fg"}`}>
              {n.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The rendered file. Markdown goes through the shared safe renderer (React nodes, never
 *  innerHTML) rather than a `<pre>`: the wiki is written to be READ, and a wall of raw
 *  markdown is not a reading room. Non-markdown text keeps its exact bytes in a `<pre>`. */
function Reader({ path, onWikiLink }: { path: string; onWikiLink?: (page: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [blob, setBlob] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!path) return;
    setText(null); setBlob(""); setError("");
    // `url` is a local, not the `blob` state: a cleanup that closed over state would capture
    // the value from the render that CREATED the effect — empty — and leak every object URL.
    let url = "";
    let cancelled = false;
    const fail = (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); };
    if (isText(path)) {
      api.libraryText(path).then((t) => { if (!cancelled) setText(t); }).catch(fail);
    } else {
      api.libraryBlobUrl(path)
        .then((u) => {
          // A selection that changed while the fetch was in flight still owns a URL to free.
          if (cancelled) return void URL.revokeObjectURL(u);
          url = u;
          setBlob(u);
        })
        .catch(fail);
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);

  // Rendered as text, never as markup: the caller's own path is echoed back in these.
  if (error) return <div className="text-[12px] text-err">{error}</div>;
  if (text !== null) {
    return isMarkdown(path)
      ? <div className="text-[13px] leading-relaxed max-w-[68ch]"><Markdown text={stripFrontmatter(text)} onWikiLink={onWikiLink} /></div>
      : <pre className="whitespace-pre-wrap text-[13px] leading-relaxed font-mono">{text}</pre>;
  }
  if (blob && isImage(path)) return <img src={blob} alt={path} className="max-w-full" />;
  if (blob && isPdf(path)) return <embed src={blob} type="application/pdf" className="w-full h-[80vh]" />;
  if (blob) return <a href={blob} download={path.split("/").pop()} className="underline underline-offset-2">Download</a>;
  return null;
}

/** Sections down the left, each collapsible with its count. Counts are the point: they say what
 *  the wiki is made of at a glance, and an empty section (analyses/ today) stays visible so its
 *  emptiness is a fact rather than an absence. */
function WikiNav({ wiki, active, onPick }: {
  wiki: WikiView; active: string; onPick: (p: WikiPageView) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {wiki.sections.map((s) => (
        <div key={s.name}>
          <details open={s.pages.length > 0 && s.pages.length <= 40}>
            <summary className="cursor-pointer flex items-center justify-between gap-2 group">
              <span className="label group-hover:text-fg">{s.name}</span>
              <span className="font-mono text-[10px] text-dim">{s.pages.length}</span>
            </summary>
            <ul className="mt-1 flex flex-col gap-0.5 pl-1">
              {s.pages.map((p) => (
                <li key={p.path}>
                  <button onClick={() => onPick(p)}
                    className={`text-left w-full truncate text-[12px] ${p.path === active ? "text-strong" : "text-dim hover:text-fg"}`}>
                    {p.name}
                  </button>
                </li>
              ))}
              {s.pages.length === 0 && <li className="text-[11px] text-dim pl-0.5">none yet</li>}
            </ul>
          </details>
        </div>
      ))}
    </div>
  );
}

export function Library() {
  const [tab, setTab] = useState<"wiki" | "archive">("wiki");
  const [wiki, setWiki] = useState<WikiView | null>(null);
  const [nodes, setNodes] = useState<LibraryNode[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LibrarySearchHit[] | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  useEffect(() => { api.libraryWiki().then(setWiki).catch(fail); }, []);
  // The archive tree is 120 KiB and is only worth fetching once the archive is actually opened.
  useEffect(() => {
    if (tab !== "archive" || nodes.length) return;
    api.libraryTree().then((r) => setNodes(r.nodes)).catch(fail);
  }, [tab, nodes.length]);

  const pageByName = useMemo(() => {
    const m = new Map<string, WikiPageView>();
    for (const s of wiki?.sections ?? []) for (const p of s.pages) m.set(p.name, p);
    return m;
  }, [wiki]);

  const current = useMemo(
    () => [...pageByName.values()].find((p) => p.path === path) ?? null,
    [pageByName, path],
  );

  const openPage = useCallback((name: string) => {
    const p = pageByName.get(name);
    if (!p) return;           // a broken link opens nothing rather than a blank reader
    setTab("wiki");
    setPath(p.path);
  }, [pageByName]);

  // Debounced so a query isn't fired per keystroke; the index is local but the render isn't free.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); return; }
    const t = setTimeout(() => {
      api.librarySearch(term).then((r) => setHits(r.hits)).catch(fail);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  const totals = wiki?.totals;
  const meta = totals
    ? `${totals.pages} pages · ${totals.links} links${totals.orphans ? ` · ${totals.orphans} orphaned` : ""}${wiki!.broken.length ? ` · ${wiki!.broken.length} broken` : ""}`
    : "workspace files, read-only";

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="page h-full flex flex-col min-h-0">
        <PageHeader title="Library" meta={meta}>
          <div className="seg">
            {(["wiki", "archive"] as const).map((t) => (
              <button key={t} onClick={() => { setTab(t); setPath(""); }}
                className={`seg-item ${tab === t ? "seg-item-active" : ""}`}>{t}</button>
            ))}
          </div>
          <input
            ref={searchBox} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search the vault…" aria-label="Search the vault"
            className="bg-raised border border-line rounded-lg px-2.5 py-1 text-[12px] w-52 focus:outline-none focus:border-info"
          />
        </PageHeader>

        {error && <div className="text-[12px] text-err mb-2">{error}</div>}

        {hits !== null ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SectionLabel>{hits.length} result{hits.length === 1 ? "" : "s"} for “{q.trim()}”</SectionLabel>
            {hits.length === 0 && <Empty>Nothing matched. Try fewer words.</Empty>}
            <ul className="flex flex-col gap-1.5 mt-2">
              {hits.map((h) => (
                <li key={h.path}>
                  <button onClick={() => { setTab(h.wiki ? "wiki" : "archive"); setPath(h.path); setQ(""); }}
                    className="card card-hover w-full text-left p-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-semibold text-bright truncate">{h.title}</span>
                      <Tag tone={h.wiki ? "info" : "dim"}>{h.wiki ? "wiki" : "record"}</Tag>
                      <span className="ml-auto font-mono text-[10px] text-dim shrink-0">{dayOf(h.ts)}</span>
                    </div>
                    <div className="text-[11.5px] text-dim mt-1 line-clamp-2">{h.snippet}</div>
                    <div className="font-mono text-[10px] text-dim mt-1 truncate">{h.path}</div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
            <div className="w-60 shrink-0 overflow-y-auto text-[12px]">
              {tab === "wiki" ? (
                wiki ? <WikiNav wiki={wiki} active={path} onPick={(p) => setPath(p.path)} />
                     : <Empty>Loading…</Empty>
              ) : (
                nodes.length === 0 && !error ? <Empty>Nothing here yet.</Empty>
                                             : <Tree nodes={nodes} onPick={setPath} active={path} />
              )}
            </div>

            <div className="flex-1 min-w-0 overflow-y-auto panel p-4">
              {!path && <Empty>{tab === "wiki" ? "Pick a page." : "Pick a file."}</Empty>}
              {path && (
                <>
                  {current && (
                    <div className="mb-3 pb-3 border-b border-line">
                      <div className="text-[15px] font-semibold text-bright">{current.title}</div>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {current.type && <Tag tone="info">{current.type}</Tag>}
                        <span className="font-mono text-[10px] text-dim">updated {dayOf(current.updated)}</span>
                        <span className="font-mono text-[10px] text-dim">
                          {current.outbound.length} out · {current.backlinks.length} in
                        </span>
                      </div>
                    </div>
                  )}
                  <Reader path={path} onWikiLink={tab === "wiki" ? openPage : undefined} />
                  {current && current.backlinks.length > 0 && (
                    <div className="mt-6 pt-3 border-t border-line">
                      <SectionLabel>Linked from</SectionLabel>
                      {/* testid: page names repeat in the sidebar, so tests need an unambiguous
                          handle on THIS panel rather than a role+name query. */}
                      <div data-testid="backlinks" className="flex flex-wrap gap-1.5 mt-1.5">
                        {current.backlinks.map((b) => (
                          <button key={b} onClick={() => openPage(b)}
                            className="text-[11.5px] text-dim hover:text-fg border border-line rounded px-1.5 py-0.5">
                            {b}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {current && current.backlinks.length === 0 && (
                    // An orphan is a bug by the wiki schema, not a neutral state — say so.
                    <div className="mt-6 pt-3 border-t border-line text-[11.5px] text-dim">
                      Nothing links here yet — this page is an orphan.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
