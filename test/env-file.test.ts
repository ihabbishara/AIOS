// test/env-file.test.ts — updateEnvFile: upsert semantics on a real temp file.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateEnvFile } from "../src/web/env-file.js";

describe("updateEnvFile", () => {
  it("replaces an existing key in place and appends a new one", () => {
    const dir = mkdtempSync(join(tmpdir(), "envf-"));
    const p = join(dir, ".env");
    writeFileSync(p, "A=1\nB=2\n");
    updateEnvFile(p, "A", "9");
    updateEnvFile(p, "C", "3");
    expect(readFileSync(p, "utf8")).toBe("A=9\nB=2\nC=3\n");
  });

  it("creates the file when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "envf-"));
    const p = join(dir, ".env");
    updateEnvFile(p, "TOKEN", "abc");
    expect(readFileSync(p, "utf8")).toBe("TOKEN=abc\n");
  });
});
