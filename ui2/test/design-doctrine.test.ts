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

  it("§2 the clock axis keeps its loudness order in BOTH themes", () => {
    // The light block used to repeat the dark values verbatim, which inverted the
    // axis: --now fell to 1.57:1 and --past rose to 6.30:1, so the live thing
    // vanished and the finished thing shouted. Pin the ORDER, not the hexes.
    const css = readFileSync(join(SRC, "tokens.css"), "utf8");

    const luminance = (hex: string): number => {
      const ch = [1, 3, 5]
        .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const contrast = (a: string, b: string): number => {
      const [x, y] = [luminance(a), luminance(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    // Grab a theme block's body by its selector, then read tokens out of it.
    const block = (selector: string): Record<string, string> => {
      const start = css.indexOf(selector);
      expect(start, `${selector} must exist in tokens.css`).toBeGreaterThan(-1);
      const body = css.slice(start, css.indexOf("}", start));
      return Object.fromEntries(
        [...body.matchAll(/(--t-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]),
      );
    };

    for (const selector of [':root[data-theme="dark"]', ':root[data-theme="light"]']) {
      const t = block(selector);
      const bg = t["--t-bg"];
      const order = ["--t-now", "--t-next", "--t-past", "--t-rest"];
      const ratios = order.map((k) => contrast(t[k], bg));
      for (let i = 1; i < ratios.length; i++) {
        expect(
          ratios[i - 1],
          `${selector}: ${order[i - 1]} (${ratios[i - 1].toFixed(2)}:1) must be louder than ${order[i]} (${ratios[i].toFixed(2)}:1)`,
        ).toBeGreaterThan(ratios[i]);
      }
      // --now and --next carry text, so they must clear 4.5:1 outright.
      expect(ratios[0], `${selector}: --t-now must be text-legible`).toBeGreaterThanOrEqual(4.5);
      expect(ratios[1], `${selector}: --t-next must be text-legible`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
