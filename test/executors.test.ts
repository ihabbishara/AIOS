// test/executors.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { VaultWriter } from "../src/vault/writer.js";
import { newRecord } from "../src/kernel/trust.js";
import { vaultWriteExecutor, echoExecutor, trustPromoteExecutor } from "../src/kernel/executors.js";

describe("echoExecutor", () => {
  it("echoes the payload text", async () => {
    const result = await echoExecutor().execute({ text: "hello" });
    expect(result).toBe("echo: hello");
  });

  it("schema rejects payloads without text", () => {
    expect(() => echoExecutor().schema.parse({})).toThrow();
  });
});

describe("vaultWriteExecutor", () => {
  it("writes a note through the vault", async () => {
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-vault-")), "AIOS");
    vault.init();
    const exec = vaultWriteExecutor(vault);
    const result = await exec.execute({ path: "notes/gate-test.md", content: "# hi" });
    expect(result).toContain("notes/gate-test.md");
    expect(vault.readNote("notes/gate-test.md")).toBe("# hi");
  });

  it("rejects paths escaping the vault", async () => {
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "aios-vault-")), "AIOS");
    vault.init();
    const exec = vaultWriteExecutor(vault);
    await expect(exec.execute({ path: "../../escape.md", content: "x" })).rejects.toThrow("escapes vault");
  });
});

describe("trustPromoteExecutor", () => {
  it("promotes the target type to autonomous", async () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    store.upsertTrust({ ...newRecord("email.send", "2026-06-12T10:00:00.000Z"), state: "graduating" });
    const exec = trustPromoteExecutor(store, bus);
    const events: unknown[] = [];
    bus.on((e) => events.push(e.event));
    await exec.execute({ action_type: "email.send" });
    expect(store.getTrust("email.send")?.state).toBe("autonomous");
    expect(events).toContainEqual({ type: "trust.changed", actionType: "email.send", state: "autonomous" });
  });

  it("aborts when the type is not graduating", async () => {
    const store = new Store(":memory:");
    store.upsertTrust(newRecord("email.send", "2026-06-12T10:00:00.000Z"));
    const exec = trustPromoteExecutor(store, new EventBus(store));
    await expect(exec.execute({ action_type: "email.send" })).rejects.toThrow("not graduating");
  });

  it("throws for unknown types", async () => {
    const store = new Store(":memory:");
    const exec = trustPromoteExecutor(store, new EventBus(store));
    await expect(exec.execute({ action_type: "nope" })).rejects.toThrow("no trust record");
  });
});
