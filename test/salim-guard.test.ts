import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { testRegistry } from "./fixtures/registry.js";
import { ledgerReadCheck } from "../src/agents/guards/read-confined.js";
import { NAMED_GUARDS } from "../src/agents/guards/index.js";

// The live testRegistry fixture builds extras with vaultPath "/tmp/v", subdir "AIOS".
const VAULT = "/tmp/v/AIOS";

describe("juno Read confinement (ledger-confine capability guard)", () => {
  const reg = testRegistry();
  const juno = reg.agents.get("juno")!;
  const guardName = juno.capabilities.map((c) => reg.capabilities.get(c)?.guard).find(Boolean)!;
  const named = NAMED_GUARDS[guardName]({ halaloDir: "/tmp/h", vaultPath: "/tmp/v", vaultSubdir: "AIOS" });
  const readCheck = named.checks.Read;

  it("wires a Read guard with the default 'allow' fallback (mirrors old FinanceAgent)", () => {
    expect(guardName).toBe("ledger-confine".replace("ledger-confine", "ledger-read-confine"));
    expect(readCheck).toBeDefined();
    expect(named.fallback ?? "allow").toBe("allow");
  });

  it("denies reads of secrets outside the finance evidence dirs", () => {
    expect(readCheck({ file_path: "/Users/x/.ssh/id_rsa" }).ok).toBe(false);
    expect(readCheck({ file_path: join(process.cwd(), ".env") }).ok).toBe(false);
    expect(readCheck({ file_path: "/etc/passwd" }).ok).toBe(false);
    expect(readCheck({}).ok).toBe(false);
  });

  it("allows invoice staging (data/downloads) and the vault finance/attachments roots", () => {
    expect(readCheck({ file_path: join(resolve("data/downloads"), "invoice-42.pdf") }).ok).toBe(true);
    expect(readCheck({ file_path: join(VAULT, "attachments", "inv.pdf") }).ok).toBe(true);
    expect(readCheck({ file_path: join(VAULT, "finance", "idama", "invoices", "2026-07", "x.pdf") }).ok).toBe(true);
  });

  it("rejects a traversal escape out of an allowed root", () => {
    expect(readCheck({ file_path: resolve("data/downloads", "..", "..", "etc", "passwd") }).ok).toBe(false);
  });
});

describe("ledgerReadCheck helper", () => {
  const check = ledgerReadCheck(["/vault/finance", "/tmp/aios-"]).Read;

  it("allows under a dir root and under a literal-prefix root", () => {
    expect(check({ file_path: "/vault/finance/x.pdf" }).ok).toBe(true);
    expect(check({ file_path: "/tmp/aios-abc/inv.pdf" }).ok).toBe(true);
  });

  it("denies a sibling dir that merely shares a name prefix", () => {
    expect(check({ file_path: "/vault/finance-secret/x" }).ok).toBe(false);
  });
});
