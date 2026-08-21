// test/resolve-behaviors.test.ts — behaviors ported from the pack-era tests (private-memo,
// pack-resolve, research-resolve, money-pack, code-pack-resolve), retargeted at resolveAgent.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { memoContextForDomain } from "../src/memory/memos.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import { loadConfig } from "../src/config.js";
import { testRegistry } from "./fixtures/registry.js";

const MEMO_MARKER = "APPROVE_INVOICES_UNDER_FIFTY_ZZZ";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  const registry = testRegistry();
  const resolve = makeResolveAgent({
    registry, store, vault, gate,
    config: { ...loadConfig(process.cwd()), fullAutonomy: false }, // pin: granular-mode wiring (flag-on lives in full-autonomy.test.ts)
    categorize: async () => "other" as const,
  });
  return { root, store, vault, registry, resolve };
}
const origin = { channel: "cli", chatId: "x" };

describe("privateMemo gating (was resolveDeptFor)", () => {
  it("midas (private) receives the money memo; juno (shared) does not — both keep mission", () => {
    const { root, vault, resolve } = setup();
    vault.writeNote("memos/money.md", `# Money\n${MEMO_MARKER}`);
    const midas = resolve("midas", origin)!;
    const juno = resolve("juno", origin)!;
    expect(midas.options.systemPrompt).toContain(MEMO_MARKER);
    expect(juno.options.systemPrompt).not.toContain(MEMO_MARKER);
    expect(midas.options.systemPrompt).toContain("group expense ledger");
    expect(juno.options.systemPrompt).toContain("group expense ledger");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("memoContextForDomain", () => {
  it("loads profile + the given domain's memo + that domain's pending teachings only", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    const s = new Store(":memory:");
    vault.writeNote("memos/profile.md", "# Profile\nSara is my partner");
    vault.writeNote("memos/money.md", "# Money\napprove invoices under fifty");
    vault.writeNote("memos/inbox.md", "# Inbox\narchive newsletters");
    s.addTeaching({ text: "always CC Sara", domain: "money", kind: "preference" });
    s.addTeaching({ text: "ignore promos", domain: "inbox", kind: "preference" });
    const block = memoContextForDomain(s, vault, "money");
    expect(block).toContain("Sara is my partner");
    expect(block).toContain("approve invoices under fifty");
    expect(block).toContain("always CC Sara");
    expect(block).not.toContain("archive newsletters");
    expect(block).not.toContain("ignore promos");
    rmSync(root, { recursive: true, force: true });
  });
  it("returns '' when nothing relevant exists", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const vault = new VaultWriter(root, "AIOS");
    vault.init();
    expect(memoContextForDomain(new Store(":memory:"), vault, "code")).toBe("");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("domain servers via capabilities (was money-pack / research-resolve)", () => {
  it("midas yields both aios-pack and money servers + fq tool names", () => {
    const { root, resolve } = setup();
    const r = resolve("midas", origin)!;
    const servers = Object.keys(r.options.mcpServers ?? {});
    expect(servers).toContain("money");
    expect(servers).toContain("aios-pack");
    expect(r.options.allowedTools).toContain("mcp__aios-pack__recall");
    expect(r.options.allowedTools).toContain("mcp__money__spending_summary");
    rmSync(root, { recursive: true, force: true });
  });

  it("clio (research lead) resolves the research server, dept context, and mapped tools", () => {
    const { root, resolve } = setup();
    const r = resolve("clio", origin)!;
    expect(Object.keys(r.options.mcpServers ?? {})).toContain("research");
    expect(r.options.systemPrompt).toContain("## Pillar: research");
    expect(r.options.allowedTools).toContain("mcp__research__save_source");
    expect(r.options.allowedTools).toContain("mcp__aios-pack__vault_write");
    expect(r.ceiling).toContain("vault.write");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("code sandbox confinement (was code-pack-resolve)", () => {
  it("with a workspace → code server + jailed guard (permissionMode default)", () => {
    const { root, resolve } = setup();
    const taskDir = mkdtempSync(join(tmpdir(), "aios-ws-")); // buildCodeServer fail-closes on a missing dir
    const r = resolve("vulcan", origin, { workspace: { taskDir, mode: "build" } })!;
    expect(Object.keys(r.options.mcpServers ?? {})).toContain("code");
    expect(r.options.permissionMode).toBe("default");
    expect(r.options.canUseTool).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });

  it("without a workspace → advisory guard, NO code server", () => {
    const { root, resolve } = setup();
    const r = resolve("vulcan", origin)!;
    expect(Object.keys(r.options.mcpServers ?? {})).not.toContain("code");
    expect(r.options.permissionMode).toBe("default");
    rmSync(root, { recursive: true, force: true });
  });

  it("a non-sandbox agent keeps its own permissionMode (no confinement)", () => {
    const { root, resolve, registry } = setup();
    const r = resolve("midas", origin)!;
    expect(r.options.permissionMode).toBe(registry.agents.get("midas")!.role.permissionMode);
    rmSync(root, { recursive: true, force: true });
  });
});
