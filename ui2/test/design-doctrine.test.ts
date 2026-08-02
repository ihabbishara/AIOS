// ui2/test/design-doctrine.test.ts — mechanical pins for DESIGN.md rules.
// Not a style linter: each check guards one rule that has already rotted once.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const codeFiles = () => walk(SRC).filter((p) => /\.(tsx?|css)$/.test(p) && !p.endsWith("tokens.css"));

describe("design doctrine (DESIGN.md)", () => {
  it("§2 color comes from tokens.css only — no raw hex in components/views", () => {
    const offenders = codeFiles().filter((p) => {
      // Strip line comments before matching so a hex in prose doesn't trip the rule.
      const text = readFileSync(p, "utf8").replace(/\/\/[^\n]*/g, "");
      return /#[0-9a-fA-F]{3,8}\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("§4 every section view except Home uses the shared .page container", () => {
    for (const view of ["Goals", "Staff", "Mail", "Schedule", "Skills", "Library", "System"]) {
      const text = readFileSync(join(SRC, "views", `${view}.tsx`), "utf8");
      expect(text.includes('"page') || text.includes("'page") || text.includes("className=\"page"), `${view}.tsx must render inside .page`).toBe(true);
    }
  });

  it("§6 motion is real — every @keyframes is on the allowlist", () => {
    // Adding an animation must be a deliberate amendment here, not a drive-by.
    // Each name is bound to a fact in 2026-08-02-home-organism-design.md §5.
    const allowed = new Set([
      "breathe",    // an agent is mid-turn
      "arrive",     // a row/chip newly entered the queue
      "edge-flash", // paired with arrive
      "shimmer",    // a node is executing
      "tick",       // a count changed
      "orb-pulse",  // the mic is recording
    ]);
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    const found = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((n) => !allowed.has(n))).toEqual([]);
  });

  it("§5 status→tone mapping is centralized — no local re-implementation of toneOfStatus", () => {
    const offenders = codeFiles().filter((p) => {
      if (p.endsWith("ui.tsx")) return false;
      const text = readFileSync(p, "utf8");
      return /function toneOfStatus/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
