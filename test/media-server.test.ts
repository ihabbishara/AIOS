// test/media-server.test.ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderChart } from "../src/media/server.js";

const havePython = (() => {
  try { execFileSync("python3", ["-c", "import matplotlib"], { timeout: 15_000 }); return true; }
  catch { return false; }
})();

describe("renderChart", () => {
  it("rejects a series whose length mismatches labels", async () => {
    const r = await renderChart(
      { type: "line", labels: ["a", "b"], series: [{ values: [1, 2, 3] }] },
      mkdtempSync(join(tmpdir(), "mchart-")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/series 1 has 3 values but there are 2 labels/);
  });

  it("rejects pie with more than one series", async () => {
    const r = await renderChart(
      { type: "pie", labels: ["a", "b"], series: [{ values: [1, 2] }, { values: [3, 4] }] },
      mkdtempSync(join(tmpdir(), "mchart-")),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pie charts take exactly one series/);
  });

  it.skipIf(!havePython)("renders a real PNG via matplotlib", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mchart-"));
    const r = await renderChart(
      { type: "bar", title: "T", labels: ["jan", "feb"], series: [{ name: "spend", values: [10, 20] }] },
      dir,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const buf = readFileSync(r.path);
      expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
  }, 30_000);
});
