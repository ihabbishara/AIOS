// ui2/src/lib/theme.ts — theme state: localStorage override, system default, <html data-theme> stamp.
export type Theme = "dark" | "light";
const KEY = "aios_theme";

export function currentTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

const listeners = new Set<(t: Theme) => void>();
/** Subscribe to theme changes — lets every toggle entry point (TopBar, command palette) stay in
 *  sync off one source of truth instead of each mirroring theme in its own local state. */
export function subscribeTheme(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
  for (const l of listeners) l(t);
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
