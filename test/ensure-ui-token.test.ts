// test/ensure-ui-token.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUiToken } from "../src/config.js";

describe("ensureUiToken", () => {
  let dir: string;
  let envPath: string;
  const saved = process.env.AIOS_UI_TOKEN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aios-token-"));
    envPath = join(dir, ".env");
    delete process.env.AIOS_UI_TOKEN;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.AIOS_UI_TOKEN;
    else process.env.AIOS_UI_TOKEN = saved;
  });

  it("generates a 64-hex token, appends to .env newline-guarded, sets process.env", () => {
    writeFileSync(envPath, "AIOS_PRIMARY_CHAT=telegram:1"); // NOTE: no trailing newline
    const logs: string[] = [];
    ensureUiToken(envPath, (m) => logs.push(m));
    const tok = process.env.AIOS_UI_TOKEN!;
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    const env = readFileSync(envPath, "utf8");
    // newline guard: the existing line must be intact on its own line
    expect(env).toContain("AIOS_PRIMARY_CHAT=telegram:1\n");
    expect(env).toContain(`AIOS_UI_TOKEN=${tok}`);
    expect(env.endsWith("\n")).toBe(true);
    expect(logs.join(" ")).toContain(tok); // printed once at boot
  });

  it("leaves an existing token untouched", () => {
    process.env.AIOS_UI_TOKEN = "existing";
    writeFileSync(envPath, "AIOS_UI_TOKEN=existing\n");
    ensureUiToken(envPath, () => {});
    expect(process.env.AIOS_UI_TOKEN).toBe("existing");
    expect(readFileSync(envPath, "utf8")).toBe("AIOS_UI_TOKEN=existing\n");
  });

  it("respects the explicit opt-out AIOS_UI_TOKEN=off", () => {
    process.env.AIOS_UI_TOKEN = "off";
    writeFileSync(envPath, "AIOS_UI_TOKEN=off\n");
    ensureUiToken(envPath, () => {});
    expect(process.env.AIOS_UI_TOKEN).toBe("off");
    expect(readFileSync(envPath, "utf8")).toBe("AIOS_UI_TOKEN=off\n");
  });

  it("works when .env does not exist yet", () => {
    ensureUiToken(envPath, () => {});
    expect(readFileSync(envPath, "utf8")).toMatch(/^AIOS_UI_TOKEN=[0-9a-f]{64}\n$/);
  });
});
