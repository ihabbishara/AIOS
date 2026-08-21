// ui2/src/components/Reader.tsx — the artifact reading view. A goal artifact is a document the
// user is meant to actually READ, not a <pre> dump: full-screen overlay, rendered markdown,
// adjustable measure and type size (persisted), esc/backdrop to close. Non-markdown files fall
// back to mono text. Reused verbatim by anything that hands the user a document.
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const WIDTHS = ["max-w-2xl", "max-w-4xl", "max-w-none"] as const;
const WIDTH_LABEL = ["narrow", "wide", "full"];
const SIZES = ["text-[13px]", "text-[14.5px]", "text-[16px]"] as const;
const PREF_KEY = "aios_reader_prefs";

function loadPrefs(): { width: number; size: number } {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") as { width?: number; size?: number };
    return { width: Math.min(p.width ?? 1, WIDTHS.length - 1), size: Math.min(p.size ?? 1, SIZES.length - 1) };
  } catch { return { width: 1, size: 1 }; }
}

export function Reader({ file, content, path, onClose }: {
  file: string; content: string;
  /** Absolute location on disk, shown and copyable — "where is this?" answered in place. */
  path?: string;
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [copied, setCopied] = useState(false);
  useEffect(() => { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); }, [prefs]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const markdown = /\.(md|markdown)$/i.test(file);
  const copyPath = () => {
    if (!path) return;
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div data-testid="reader" className="fixed inset-0 z-50 bg-bg/85 backdrop-blur-sm flex flex-col"
      onClick={onClose}>
      <div className="flex items-center gap-3 px-4 h-12 border-b border-line bg-surface shrink-0"
        onClick={(e) => e.stopPropagation()}>
        <span className="text-strong text-[13px] font-medium truncate">{file}</span>
        {path && (
          <button onClick={copyPath} title={path}
            className="text-[10.5px] text-dim hover:text-fg font-mono truncate max-w-[36ch] hidden md:block">
            {copied ? "copied ✓" : path}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button aria-label="Narrower text" onClick={() => setPrefs((p) => ({ ...p, size: Math.max(0, p.size - 1) }))}
            className="text-dim hover:text-fg text-[11px] border border-line rounded px-1.5 py-0.5">A−</button>
          <button aria-label="Larger text" onClick={() => setPrefs((p) => ({ ...p, size: Math.min(SIZES.length - 1, p.size + 1) }))}
            className="text-dim hover:text-fg text-[13px] border border-line rounded px-1.5 py-0.5">A+</button>
          <button aria-label="Reading width" onClick={() => setPrefs((p) => ({ ...p, width: (p.width + 1) % WIDTHS.length }))}
            className="text-dim hover:text-fg text-[11px] border border-line rounded px-1.5 py-0.5 w-14">
            {WIDTH_LABEL[prefs.width]}
          </button>
          <button aria-label="Close reader" onClick={onClose}
            className="text-dim hover:text-strong text-[15px] leading-none px-1.5">✕</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className={`mx-auto px-6 py-8 ${WIDTHS[prefs.width]} ${SIZES[prefs.size]}`}>
          {markdown
            ? <div className="reader-prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
            : <pre className="font-mono text-[0.85em] whitespace-pre-wrap">{content}</pre>}
        </div>
      </div>
    </div>
  );
}
