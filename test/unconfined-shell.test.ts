// test/unconfined-shell.test.ts — an agent holding raw Bash is confined, capability or not.
//
// Ground truth (2026-09-02 audit of the live org): every agent with raw Bash — argus, loom,
// themis, vulcan, weave — pairs `shell` with `code-sandbox`, so the resolver's confinement
// branch mounts the workspace jail (or, with no workspace, the advisory guard). Exactly one
// did not: `grove`, minted through Mission Control's hiring flow on 2026-08-25 with
// [files-ro, editing, shell, web-fetch, memory] and permissionMode `dontAsk`. Because the
// branch was keyed on the CAPABILITY rather than on the tools actually granted, he skipped it
// entirely — his guard answered "allow" to `rm -rf ~/projects`, with no prompt and no jail.
//
// The org's real invariant was never "sandbox agents are confined". It was "raw exec is
// confined"; the two only looked identical because every hand-written manifest paired them.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { ActionGate } from "../src/kernel/gate.js";
import { ExecutorRegistry } from "../src/kernel/actions.js";
import { EventBus } from "../src/events.js";
import { DEFAULT_POLICY } from "../src/kernel/trust.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR } from "./fixtures/org.js";

const ORIGIN = { channel: "cli", chatId: "x" };
const OUTSIDE = "/Users/someone/projects";

/** grove's exact shape: raw shell + editing, NO code-sandbox, dontAsk. */
const GROVE = `name: grove
title: Shelfee Platform Engineer
department: clients
charter: Owns the product end-to-end — reads, writes, and deploys.
persona: Direct and systems-minded.
prompt: You are the dedicated engineer for the product.
maxTurns: 25
permissionMode: dontAsk
kind: lead
capabilities: [files-ro, editing, shell, web-fetch, memory]
`;

const DEPT = `department: clients
mission: Client-project agents — read-only experts on external systems.
lead: grove
memoDomain: general
actions: []
playbooks: []
capabilities: []
`;

function setup(manifest = GROVE) {
  const agentsDir = mkdtempSync(join(tmpdir(), "org-"));
  copyFileSync(join(FIXTURE_AGENTS_DIR, "_capabilities.yaml"), join(agentsDir, "_capabilities.yaml"));
  // The loader requires exactly one coordinator; borrow the fixture org's.
  cpSync(join(FIXTURE_AGENTS_DIR, "operations"), join(agentsDir, "operations"), { recursive: true });
  mkdirSync(join(agentsDir, "clients"));
  writeFileSync(join(agentsDir, "clients", "department.yaml"), DEPT);
  writeFileSync(join(agentsDir, "clients", "grove.yaml"), manifest);

  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const store = new Store(":memory:");
  const bus = new EventBus(store);
  const vault = new VaultWriter(root, "AIOS");
  vault.init();
  const gate = new ActionGate({ store, registry: new ExecutorRegistry(), policy: DEFAULT_POLICY, bus, expiryMs: 60_000 });
  const config = { ...loadConfig(process.cwd()), fullAutonomy: false };
  const registry = loadRegistry(agentsDir, FIXTURE_PLAYBOOKS_DIR, buildExtras(config), () => {});
  const resolve = makeResolveAgent({ registry, store, vault, gate, config, categorize: async () => "other" as const });
  const cleanup = () => { rmSync(agentsDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); };
  return { resolve, cleanup };
}

const ask = async (r: { options: { canUseTool?: unknown } }, tool: string, input: Record<string, unknown>) => {
  const cut = r.options.canUseTool as
    | ((t: string, i: Record<string, unknown>, o: unknown) => Promise<{ behavior: string }>)
    | undefined;
  if (!cut) return "no-guard";
  return (await cut(tool, input, {})).behavior;
};

describe("an agent granted raw Bash without a sandbox capability", () => {
  it("has a guard at all — the hole was that no guard covered its shell", async () => {
    const { resolve, cleanup } = setup();
    const r = resolve("grove", ORIGIN)!;
    expect(r.options.canUseTool).toBeDefined();
    cleanup();
  });

  it("cannot run a destructive shell command outside any workspace", async () => {
    const { resolve, cleanup } = setup();
    const r = resolve("grove", ORIGIN)!;
    expect(await ask(r, "Bash", { command: `rm -rf ${OUTSIDE}` })).toBe("deny");
    cleanup();
  });

  it("cannot write or edit outside any workspace either", async () => {
    const { resolve, cleanup } = setup();
    const r = resolve("grove", ORIGIN)!;
    expect(await ask(r, "Write", { file_path: `${OUTSIDE}/x.ts`, content: "x" })).toBe("deny");
    expect(await ask(r, "Edit", { file_path: `${OUTSIDE}/x.ts` })).toBe("deny");
    cleanup();
  });

  it("is confined inside a workspace instead of anywhere on disk", async () => {
    const { resolve, cleanup } = setup();
    const taskDir = mkdtempSync(join(tmpdir(), "ws-"));
    const r = resolve("grove", ORIGIN, { workspace: { taskDir, mode: "build" } })!;
    expect(await ask(r, "Write", { file_path: join(taskDir, "src", "x.ts"), content: "x" })).toBe("allow");
    expect(await ask(r, "Write", { file_path: `${OUTSIDE}/x.ts`, content: "x" })).toBe("deny");
    rmSync(taskDir, { recursive: true, force: true });
    cleanup();
  });

  it("loses permissionMode dontAsk — confinement and no-prompting cannot both hold", async () => {
    const { resolve, cleanup } = setup();
    expect(resolve("grove", ORIGIN)!.options.permissionMode).toBe("default");
    cleanup();
  });

  it("keeps the non-exec tools its capabilities grant", async () => {
    // The 2026-07-18 lesson: a deny-everything fallback strips tools the capability union
    // granted. WebFetch comes from `web-fetch` and must survive confinement.
    const { resolve, cleanup } = setup();
    const r = resolve("grove", ORIGIN)!;
    expect(r.options.allowedTools).toContain("WebFetch");
    expect(r.options.allowedTools).toContain("mcp__aios-pack__recall");
    cleanup();
  });

  it("leaves an agent with no raw shell alone", async () => {
    // Write without Bash is a long-standing deliberate grant (halalo's `drafting`); sweeping it
    // in here would disable a working agent to fix a different one's hole.
    const { resolve, cleanup } = setup(GROVE.replace("[files-ro, editing, shell, web-fetch, memory]", "[files-ro, drafting, web-fetch, memory]"));
    const r = resolve("grove", ORIGIN)!;
    expect(r.options.allowedTools).toContain("Write");
    expect(await ask(r, "Write", { file_path: `${OUTSIDE}/x.md`, content: "x" })).not.toBe("deny");
    cleanup();
  });
});
