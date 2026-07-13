// ui2/src/components/TopBar.tsx — AIOS · Home Goals Staff Mail System ··· budget · connection dot · ⌘K.
import type { BudgetInfo } from "../api.js";
import { SECTIONS, href } from "../lib/router.js";
import { usd } from "../lib/format.js";

export function TopBar({ section, budget, connected, needsYou, onPalette }: {
  section: string; budget: BudgetInfo | undefined; connected: boolean;
  needsYou: number; onPalette: () => void;
}) {
  return (
    <header className="flex items-center gap-1 px-4 h-12 border-b border-line bg-surface shrink-0">
      <a href={href("home")} className="text-strong font-medium text-[14px] mr-4 tracking-wide">AIOS</a>
      <nav className="hidden md:flex items-center gap-1">
        {SECTIONS.map((s) => (
          <a
            key={s}
            href={href(s)}
            className={`px-2.5 py-1.5 rounded-md text-[12px] capitalize transition-colors ${
              section === s ? "text-strong bg-raised" : "text-dim hover:text-fg"
            }`}
          >
            {s}
            {s === "home" && needsYou > 0 && (
              <span className="ml-1.5 text-[10px] text-bg bg-accent rounded-full px-1.5 tick">{needsYou}</span>
            )}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-4">
        {budget && budget.capCents != null && (
          <span className="text-[11px] text-dim" title={`daily budget · ${budget.date}`}>
            {usd(budget.spentCents)} / {usd(budget.capCents)}
          </span>
        )}
        <span
          title={connected ? "live" : "reconnecting"}
          className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-ok breathe" : "bg-err"}`}
        />
        <button onClick={onPalette} className="label hover:text-fg">⌘K</button>
      </div>
    </header>
  );
}
