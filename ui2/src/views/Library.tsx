// ui2/src/views/Library.tsx — the shelf: what the org has produced, newest first.
//
// This replaces the wiki taxonomy (concepts/entities/sources — agent-recall machinery a human
// almost never opened) and the raw archive tree as the front door. The unit here is a piece of
// finished work: a completed goal with its deliverable files, or a standalone document from
// reports/ research/ notes/. The record itself stays on disk (Obsidian, agent recall) and stays
// searchable from here — the cockpit just stops fronting internals as if they were the product.
import { useEffect, useMemo, useState } from "react";
import { api, type LibrarySearchHit, type ShelfDoc, type ShelfFile, type ShelfView, type ShelfWork } from "../api.js";
import { Empty, PageHeader, SectionLabel, Tag } from "../components/ui.js";
import { Reader } from "../components/Reader.js";

const isText = (p: string) => /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(p);
// `.svg` is absent on purpose: SVG is active content, the server refuses to type it as an image,
// and it belongs on the download path rather than in an element this origin renders.
const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
const isPdf = (p: string) => /\.pdf$/i.test(p);

const dayOf = (iso: string) => iso.slice(0, 10);
const kb = (size: number) => `${Math.max(1, Math.round(size / 1024))} KB`;
const monthOf = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Does this actually end like a PDF? Every real one closes with `%%EOF`.
 *
 * A failed render once wrote a 57-byte placeholder — the literal text "%PDF-1.7 binary payload —
 * cannot be represented as text". The `%PDF` header is enough for the server to type it
 * application/pdf, so it reached an <embed> and rendered as a silently broken viewer. Agents
 * write these files, so a stub is a thing that recurs; say what happened instead.
 */
async function endsLikePdf(b: Blob): Promise<boolean> {
  const tail = await b.slice(Math.max(0, b.size - 1024)).text();
  return tail.trimEnd().endsWith("%%EOF");
}

/**
 * Full-screen reading surface for one shelf file. Text and markdown hand off to the shared
 * Reader (rendered markdown, adjustable measure — the same surface goal artifacts use, so a
 * document reads identically wherever it is opened from). Binary files get the same overlay
 * shape with an image / pdf / download body. Errors render as TEXT — the server echoes the
 * caller's path back in refusals, so that slot is attacker-influenced.
 */
function FileReader({ name, path, onClose }: { name: string; path: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [blob, setBlob] = useState("");
  const [broken, setBroken] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // `url` is a local, not the `blob` state: a cleanup that closed over state would capture
    // the value from the render that CREATED the effect — empty — and leak every object URL.
    let url = "";
    let cancelled = false;
    const fail = (e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); };
    if (isText(path)) {
      api.libraryText(path).then((t) => { if (!cancelled) setText(t); }).catch(fail);
    } else {
      api.libraryBlob(path)
        .then(async (b) => {
          if (cancelled) return;
          if (isPdf(path)) setBroken(!(await endsLikePdf(b)));
          const u = URL.createObjectURL(b);
          // A close that raced the fetch still owns a URL to free.
          if (cancelled) return void URL.revokeObjectURL(u);
          url = u;
          setBlob(u);
        })
        .catch(fail);
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (text !== null && !error) return <Reader file={name} content={text} path={path} onClose={onClose} />;

  // Binary, still-loading, and error states share one overlay so a click always shows SOMETHING.
  return (
    <div data-testid="file-reader" className="fixed inset-0 z-50 bg-bg/85 backdrop-blur-sm flex flex-col" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 h-12 border-b border-line bg-surface shrink-0"
        onClick={(e) => e.stopPropagation()}>
        <span className="text-strong text-[13px] font-medium truncate">{name}</span>
        <span className="font-mono text-[10.5px] text-dim truncate hidden md:block">{path}</span>
        <button onClick={onClose} aria-label="Close" className="ml-auto text-dim hover:text-fg text-[15px] px-1">✕</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        {error && <div className="text-[12px] text-err">{error}</div>}
        {!error && !blob && <div className="text-[12px] text-dim">Loading…</div>}
        {blob && isImage(path) && <img src={blob} alt={name} className="max-w-full mx-auto" />}
        {blob && isPdf(path) && broken && (
          <div className="text-[12px] text-dim flex flex-col gap-2 items-start">
            <span>This file is named .pdf but has no PDF end marker — the render that produced it
              did not finish, so there is nothing to display.</span>
            <a href={blob} download={name} className="underline underline-offset-2">Download it anyway</a>
          </div>
        )}
        {blob && isPdf(path) && !broken && <embed src={blob} type="application/pdf" className="w-full h-full min-h-[80vh]" />}
        {blob && !isImage(path) && !isPdf(path) && (
          <a href={blob} download={name} className="underline underline-offset-2 text-[12px]">Download</a>
        )}
      </div>
    </div>
  );
}

/** One deliverable file as an openable chip. The headline — the file the goal existed to
 *  produce — leads and reads brighter; the rest are the supporting output. */
function FileChip({ file, headline, onOpen }: { file: ShelfFile; headline: boolean; onOpen: (f: ShelfFile) => void }) {
  return (
    <button onClick={() => onOpen(file)} data-testid="shelf-file"
      className={`border rounded-lg px-2 py-1 flex items-center gap-1.5 text-left transition-colors ${
        headline ? "border-dim text-strong hover:text-bright" : "border-line text-dim hover:text-fg"
      }`}>
      <span className="text-[11px]">📄</span>
      <span className="text-[11.5px] truncate max-w-[26ch]">{file.name}</span>
      <span className="font-mono text-[9.5px] opacity-70 shrink-0">{kb(file.size)}</span>
    </button>
  );
}

function WorkCard({ work, onOpen }: { work: ShelfWork; onOpen: (f: ShelfFile) => void }) {
  // Headline first, then the rest newest-first (server order). Long tails fold: a deck goal
  // left 30+ files, and a card that tall buries every goal beneath it.
  const files = useMemo(() => {
    const head = work.files.find((f) => f.name === work.headline);
    return head ? [head, ...work.files.filter((f) => f !== head)] : work.files;
  }, [work]);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? files : files.slice(0, 6);

  return (
    <div className="card p-3" data-testid="shelf-work">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[13px] font-semibold text-bright truncate">{work.title}</span>
        {work.status !== "done" && <Tag tone={work.status === "failed" ? "err" : "dim"}>{work.status}</Tag>}
        <span className="ml-auto shrink-0 flex items-center gap-2">
          <Tag>{work.department}</Tag>
          <span className="font-mono text-[10px] text-dim">{dayOf(work.finishedAt)}</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {shown.map((f) => <FileChip key={f.path} file={f} headline={f.name === work.headline} onOpen={onOpen} />)}
        {files.length > shown.length && (
          <button onClick={() => setShowAll(true)} className="text-[11px] text-dim hover:text-fg px-1">
            +{files.length - shown.length} more
          </button>
        )}
      </div>
      <a href={`#/goals/${work.slug}`} className="inline-block mt-2 text-[10.5px] text-dim hover:text-fg">
        how it was made ↗
      </a>
    </div>
  );
}

function DocRow({ doc, onOpen }: { doc: ShelfDoc; onOpen: (f: { name: string; path: string }) => void }) {
  return (
    <button onClick={() => onOpen(doc)} data-testid="shelf-doc"
      className="card card-hover w-full text-left px-3 py-2 flex items-center gap-2 min-w-0">
      <Tag tone="info">{doc.folder}</Tag>
      <span className="text-[12.5px] text-fg truncate">{doc.title}</span>
      <span className="ml-auto shrink-0 flex items-center gap-2">
        <span className="font-mono text-[9.5px] text-dim">{kb(doc.size)}</span>
        <span className="font-mono text-[10px] text-dim">{dayOf(doc.mtime)}</span>
      </span>
    </button>
  );
}

type ShelfItem = { date: string; work?: ShelfWork; doc?: ShelfDoc };

export function Library() {
  const [shelf, setShelf] = useState<ShelfView | null>(null);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<"all" | "goals" | "docs">("all");
  const [open, setOpen] = useState<{ name: string; path: string } | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LibrarySearchHit[] | null>(null);

  useEffect(() => {
    api.libraryShelf().then(setShelf).catch((e: unknown) => {
      // dist deploys the instant it builds, while the daemon serves the endpoint only after a
      // restart — so a missing shelf must say "restart", not read as an empty library.
      const msg = e instanceof Error ? e.message : String(e);
      setError(`The shelf did not load (${msg}). If AIOS was just updated, restart the daemon.`);
    });
  }, []);

  // Debounced so a query isn't fired per keystroke; the index is local but the render isn't free.
  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); return; }
    const t = setTimeout(() => {
      api.librarySearch(term)
        .then((r) => setHits(r.hits))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  /** Works and docs merged into one timeline, grouped by month. One stream, because the user's
   *  question is "what did the org produce lately" — not "which table did it land in". */
  const months = useMemo(() => {
    if (!shelf) return [];
    const items: ShelfItem[] = [
      ...(kind === "docs" ? [] : shelf.works.map((w) => ({ date: w.finishedAt, work: w }))),
      ...(kind === "goals" ? [] : shelf.docs.map((d) => ({ date: d.mtime, doc: d }))),
    ].sort((a, b) => b.date.localeCompare(a.date));
    const out: Array<{ month: string; items: ShelfItem[] }> = [];
    for (const it of items) {
      const m = monthOf(it.date);
      if (out.at(-1)?.month === m) out.at(-1)!.items.push(it);
      else out.push({ month: m, items: [it] });
    }
    return out;
  }, [shelf, kind]);

  const openFile = (f: { name: string; path: string }) => setOpen({ name: f.name, path: f.path });

  const meta = shelf
    ? `${shelf.works.length} finished goal${shelf.works.length === 1 ? "" : "s"} · ${shelf.docs.length} documents`
    : error ? "unavailable" : "loading…";

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="page h-full flex flex-col min-h-0">
        <PageHeader title="Library" meta={meta}>
          <div className="seg">
            {(["all", "goals", "docs"] as const).map((t) => (
              <button key={t} onClick={() => setKind(t)}
                className={`seg-item ${kind === t ? "seg-item-active" : ""}`}>{t}</button>
            ))}
          </div>
          <input
            value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search everything…" aria-label="Search everything"
            className="bg-raised border border-line rounded-lg px-2.5 py-1 text-[12px] w-52 focus:outline-none focus:border-info"
          />
        </PageHeader>

        {/* Rendered as text, never as markup: server refusals echo caller-influenced paths. */}
        {error && <div className="text-[12px] text-err mb-2">{error}</div>}

        {hits !== null ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <SectionLabel>{hits.length} result{hits.length === 1 ? "" : "s"} for “{q.trim()}”</SectionLabel>
            {hits.length === 0 && <Empty>Nothing matched. Try fewer words.</Empty>}
            <ul className="flex flex-col gap-1.5 mt-2">
              {hits.map((h) => (
                <li key={h.path}>
                  <button onClick={() => openFile({ name: h.path.split("/").pop() ?? h.path, path: h.path })}
                    className="card card-hover w-full text-left p-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] font-semibold text-bright truncate">{h.title}</span>
                      {/* The first path segment says which shelf of the record it came from. */}
                      <Tag>{h.path.split("/")[0]}</Tag>
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
          <div className="flex-1 min-h-0 overflow-y-auto">
            {shelf && months.length === 0 && (
              <Empty>Nothing on the shelf yet — finished goals and their deliverables land here.</Empty>
            )}
            {!shelf && !error && <Empty>Loading…</Empty>}
            {months.map((g) => (
              <div key={g.month} className="mb-5">
                <SectionLabel>{g.month}</SectionLabel>
                <div className="flex flex-col gap-2 mt-2">
                  {g.items.map((it) =>
                    it.work
                      ? <WorkCard key={it.work.id} work={it.work} onOpen={openFile} />
                      : <DocRow key={it.doc!.path} doc={it.doc!} onOpen={openFile} />,
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {open && <FileReader name={open.name} path={open.path} onClose={() => setOpen(null)} />}
      </div>
    </div>
  );
}
