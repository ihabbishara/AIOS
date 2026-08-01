// ui2/src/views/Library.tsx — read-only workspace browser (spec §4). Obsidian is a bonus
// viewer, not infrastructure: everything the org writes must be readable here.
import { useEffect, useState } from "react";
import { api, type LibraryNode } from "../api.js";
import { Empty, PageHeader } from "../components/ui.js";

const isText = (p: string) => /\.(md|markdown|txt|json|csv|ya?ml)$/i.test(p);
// `.svg` is absent on purpose: SVG is active content, the server refuses to type it as an image,
// and it belongs on the download path rather than in an element this origin renders.
const isImage = (p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p);
const isPdf = (p: string) => /\.pdf$/i.test(p);

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

export function Library() {
  const [nodes, setNodes] = useState<LibraryNode[]>([]);
  // null means "nothing loaded", which an empty file would otherwise be indistinguishable from.
  const [text, setText] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [blob, setBlob] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api.libraryTree().then((r) => setNodes(r.nodes))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

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

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      <div className="page h-full flex flex-col min-h-0">
        <PageHeader title="Library" meta="workspace files, read-only" />
        <div className="flex-1 min-h-0 flex gap-4 overflow-hidden">
          <div className="w-56 shrink-0 overflow-y-auto text-[12px]">
            {nodes.length === 0 && !error && <Empty>Nothing here yet.</Empty>}
            <Tree nodes={nodes} onPick={setPath} active={path} />
          </div>
          <div className="flex-1 overflow-y-auto panel p-4">
            {/* Rendered as text, never as markup: the caller's own path is echoed back in these. */}
            {error && <div className="text-[12px] text-err">{error}</div>}
            {!path && !error && <Empty>Pick a file.</Empty>}
            {/* Markdown stays preformatted. Workspace files are agent output — untrusted input —
                and parsing them into HTML without a sanitizer is the XSS path this view avoids. */}
            {text !== null && <pre className="whitespace-pre-wrap text-[13px] leading-relaxed font-sans">{text}</pre>}
            {blob && isImage(path) && <img src={blob} alt={path} className="max-w-full" />}
            {blob && isPdf(path) && <embed src={blob} type="application/pdf" className="w-full h-[80vh]" />}
            {blob && !isImage(path) && !isPdf(path) && (
              <a href={blob} download={path.split("/").pop()} className="underline underline-offset-2">Download</a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
