import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunqSense } from "../src/senses/bunq/index.js";

function opts(contextPath: string) {
  return { contextPath, helperPath: "/x/bunq_read.py", env: "sandbox", backfillDays: 90, pythonBin: "python3" };
}

describe("BunqSense lifecycle", () => {
  it("is disabled when the context file is absent", () => {
    const sense = BunqSense.load(opts("/nope/missing.conf"));
    expect(sense.enabled()).toBe(false);
    expect(sense.degraded()[0].reason).toMatch(/bunq-setup/);
  });
  it("is enabled when a context file exists; degraded toggles", () => {
    const dir = mkdtempSync(join(tmpdir(), "bunq-"));
    const ctx = join(dir, "ctx.conf");
    writeFileSync(ctx, "{}");
    const sense = BunqSense.load(opts(ctx));
    expect(sense.enabled()).toBe(true);
    expect(sense.degraded()).toEqual([]);
    sense.markDegraded("re-auth needed");
    expect(sense.degraded()).toEqual([{ name: "bunq", reason: "re-auth needed" }]);
    sense.clearDegraded();
    expect(sense.degraded()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
