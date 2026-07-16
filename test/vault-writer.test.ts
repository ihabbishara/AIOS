// test/vault-writer.test.ts — daily-note write-path: LOCAL date/time (was UTC → entries scattered
// into the wrong day for a non-UTC user), and the dead job-artifact methods are gone.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultWriter, localDate, localHM } from "../src/vault/writer.js";

function tmpVault(): VaultWriter {
  const w = new VaultWriter(mkdtempSync(join(tmpdir(), "vault-")), "AIOS");
  w.init();
  return w;
}

describe("local date/time helpers", () => {
  it("format a Date in LOCAL components, not UTC", () => {
    // Constructed in local time and read back in local time → deterministic in any TZ.
    // The old toISOString path would give a different day/time for any non-UTC offset.
    const d = new Date(2026, 5, 20, 1, 25); // 2026-06-20 01:25 LOCAL (month 5 = June)
    expect(localDate(d)).toBe("2026-06-20");
    expect(localHM(d)).toBe("01:25");
    expect(localHM(new Date(2026, 0, 3, 9, 7))).toBe("09:07"); // zero-padded
  });
});

describe("appendDaily", () => {
  it("writes to the LOCAL-dated file with a LOCAL timestamp", () => {
    const w = tmpVault();
    w.appendDaily("hello");
    const file = join(w.root, "daily", `${localDate()}.md`);
    expect(existsSync(file)).toBe(true);
    const body = readFileSync(file, "utf8");
    expect(body).toContain(`# ${localDate()}`);
    expect(body).toMatch(new RegExp(`- ${localHM()} hello`));
  });
});

describe("dead job-artifact methods are removed", () => {
  it("no longer exposes the orphaned jobs API", () => {
    const w = tmpVault() as unknown as Record<string, unknown>;
    for (const m of ["writeJobArtifact", "readJobArtifact", "jobDirName", "jobDir"]) {
      expect(typeof w[m]).toBe("undefined");
    }
  });
});
