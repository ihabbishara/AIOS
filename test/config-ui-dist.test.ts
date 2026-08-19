// test/config-ui-dist.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

const prev = process.env.AIOS_UI_DIST;
afterEach(() => {
  if (prev === undefined) delete process.env.AIOS_UI_DIST;
  else process.env.AIOS_UI_DIST = prev;
});

describe("AIOS_UI_DIST", () => {
  it("prefers a working-tree ui2/dist when the root has one", () => {
    delete process.env.AIOS_UI_DIST;
    const root = mkdtempSync(join(tmpdir(), "aios-uidist-"));
    mkdirSync(join(root, "ui2", "dist"), { recursive: true });
    expect(loadConfig(root).uiDist).toBe(join(root, "ui2", "dist"));
  });

  // The regression that shipped in 0.1.0: uiDist is PACKAGE data but resolved against cwd, so a
  // real `npm i` (cwd = the consumer's project) served the setup wizard as 503 "UI not built yet".
  // Extracting the tarball and booting inside it hid this, because there cwd IS the package root.
  it("falls back to the shipped bundle when the root has none", () => {
    delete process.env.AIOS_UI_DIST;
    const root = mkdtempSync(join(tmpdir(), "aios-uidist-"));
    const uiDist = loadConfig(root).uiDist;
    expect(uiDist).not.toBe(join(root, "ui2", "dist"));
    expect(existsSync(uiDist)).toBe(true);
    expect(existsSync(join(uiDist, "index.html"))).toBe(true);
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

describe("shipped package assets", () => {
  // templates/ and playbooks/ are in the files allowlist too and had the same cwd bug -- they
  // just fail later than the wizard does, so nothing caught them.
  it("resolve to real directories from a root that has none", () => {
    const root = mkdtempSync(join(tmpdir(), "aios-assets-"));
    const config = loadConfig(root);
    for (const dir of [config.templatesDir, config.playbooksDir]) {
      expect(dir).not.toBe(join(root, dir.split("/").pop()!));
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("leaves user data (agents, data, .env) resolved against the working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "aios-userdata-"));
    const config = loadConfig(root);
    expect(config.agentsDir).toBe(join(root, "agents"));
    expect(config.envPath).toBe(join(root, ".env"));
  });
});
