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

  it("§5 status→tone mapping is centralized — no local re-implementation of toneOfStatus", () => {
    const offenders = codeFiles().filter((p) => {
      if (p.endsWith("ui.tsx")) return false;
      const text = readFileSync(p, "utf8");
      return /function toneOfStatus/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
