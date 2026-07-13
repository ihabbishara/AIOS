// test/config-ui-dist.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

const prev = process.env.AIOS_UI_DIST;
afterEach(() => {
  if (prev === undefined) delete process.env.AIOS_UI_DIST;
  else process.env.AIOS_UI_DIST = prev;
});

describe("AIOS_UI_DIST", () => {
  it("defaults to <root>/ui/dist", () => {
    delete process.env.AIOS_UI_DIST;
    expect(loadConfig("/tmp/x").uiDist).toBe("/tmp/x/ui/dist");
  });
  it("resolves a relative override against root", () => {
    process.env.AIOS_UI_DIST = "ui2/dist";
    expect(loadConfig("/tmp/x").uiDist).toBe("/tmp/x/ui2/dist");
  });
  it("keeps an absolute override as-is", () => {
    process.env.AIOS_UI_DIST = "/opt/dist";
    expect(loadConfig("/tmp/x").uiDist).toBe("/opt/dist");
  });
});
