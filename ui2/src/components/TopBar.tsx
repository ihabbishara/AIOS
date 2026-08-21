// ui2/src/components/TopBar.tsx — AIOS · Home Goals Staff Mail System ··· budget · theme · connection dot · ⌘K.
import { useState, useEffect } from "react";
import type { BudgetInfo } from "../api.js";
import { SECTIONS, href } from "../lib/router.js";
import { usd } from "../lib/format.js";
import { currentTheme, toggleTheme, subscribeTheme } from "../lib/theme.js";

export function TopBar({ section, budget, connected, needsYou, mailForYou = 0, fullAutonomy = false, onPalette, onChat }: {
  section: string; budget: BudgetInfo | undefined; connected: boolean;
  needsYou: number; mailForYou?: number; fullAutonomy?: boolean; onPalette: () => void; onChat: () => void;
}) {
  const [theme, setThemeState] = useState(currentTheme());
  // Subscribe so a toggle from ANY entry point (this button, the ⌘K palette) keeps the glyph in
  // sync — the icon used to desync when the palette toggled theme without touching this state.
  useEffect(() => subscribeTheme(setThemeState), []);
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
            {s === "mail" && mailForYou > 0 && (
              <span className="ml-1.5 text-[10px] text-bg bg-info rounded-full px-1.5">{mailForYou}</span>
            )}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-4">
        {/* The owner must SEE the mode: unguarded agents are running without allowlist
            enforcement (AIOS_FULL_AUTONOMY=1). Small, persistent, honest. */}
        {fullAutonomy && (
          <span title="Unguarded agents run with full tool access — AIOS_FULL_AUTONOMY=1 (System → Config)"
            className="text-[10px] tracking-wide text-accent border border-accent/40 rounded px-1.5 py-0.5 select-none">
            FULL AUTONOMY
          </span>
        )}
        <button
          onClick={onChat}
          className="hidden md:flex items-center gap-1.5 border border-line rounded-md px-2.5 py-1 text-[11.5px] text-fg hover:text-strong hover:border-dim transition-colors"
        >
          Chat <kbd className="!bg-transparent !border-line">⌘J</kbd>
        </button>
        {budget && budget.capCents != null && (
          <span className="text-[11px] text-dim" title={`daily budget · ${budget.date}`}>
            {usd(budget.spentCents)} / {usd(budget.capCents)}
          </span>
        )}
        <button
          aria-label="Toggle theme"
          onClick={() => toggleTheme()}
          className="text-[13px] text-dim hover:text-strong transition-colors"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <span
          title={connected ? "live" : "reconnecting"}
          className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-ok breathe" : "bg-err"}`}
        />
        <button onClick={onPalette} className="label hover:text-fg">⌘K</button>
      </div>
    </header>
  );
}
