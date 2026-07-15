// ui2/test/theme.test.ts — system default, persistence, toggle side-effects.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { currentTheme, setTheme, toggleTheme, applyTheme } from "../src/lib/theme.js";

function stubScheme(prefersLight: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("light") ? prefersLight : !prefersLight,
    addEventListener: () => {}, removeEventListener: () => {},
  }));
}

describe("theme", () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });

  it("defaults to the system scheme when nothing is stored", () => {
    stubScheme(false);
    expect(currentTheme()).toBe("dark");
    stubScheme(true);
    expect(currentTheme()).toBe("light");
  });

  it("stored value wins over the system scheme", () => {
    stubScheme(true);
    localStorage.setItem("aios_theme", "dark");
    expect(currentTheme()).toBe("dark");
  });

  it("setTheme persists and stamps <html data-theme>", () => {
    setTheme("light");
    expect(localStorage.getItem("aios_theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("toggleTheme flips dark↔light", () => {
    stubScheme(false);
    expect(toggleTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("applyTheme stamps without persisting", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("aios_theme")).toBeNull();
  });
});
