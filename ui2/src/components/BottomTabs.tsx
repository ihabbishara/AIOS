// ui2/src/components/BottomTabs.tsx — phone nav: every SECTIONS entry as a bottom tab (spec §7).
import { SECTIONS, href } from "../lib/router.js";

const ICONS: Record<string, string> = { home: "◉", goals: "◎", staff: "▤", mail: "✉", schedule: "◷", skills: "✦", library: "▦", system: "⚙" };

export function BottomTabs({ section, needsYou }: { section: string; needsYou: number }) {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-surface border-t border-line flex"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {SECTIONS.map((s) => (
        <a key={s} href={href(s)}
          className={`flex-1 flex flex-col items-center justify-center gap-0.5 min-h-11 ${
            section === s ? "text-bright" : "text-dim"
          }`}>
          <span className="relative text-[15px]">
            {ICONS[s]}
            {s === "home" && needsYou > 0 && (
              <span className="absolute -top-1 -right-3 text-[9px] text-bg bg-accent rounded-full px-1">{needsYou}</span>
            )}
          </span>
          <span className="text-[9px] uppercase tracking-wider">{s}</span>
        </a>
      ))}
    </nav>
  );
}
