// test/full-autonomy.test.ts — AIOS_FULL_AUTONOMY=1: unguarded, non-sandbox agents run
// bypassPermissions (the SDK auto-approves built-ins and the denial observer self-disables),
// while guards, the sandbox jail, and the capability-derived tool LIST stay exactly as they are.
// The flag changes enforcement, never the surface.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry, isGuarded } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { buildConfig, loadConfig, parseAutonomy } from "../src/config.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import { withDenialObserver } from "../src/agents/permissions.js";
import { withMailOptions } from "../src/agents/runner.js";
import { MAIL_TOOL, ASK_TOOL } from "../src/mail/server.js";
import type { Mailbox } from "../src/mail/mailbox.js";
import { FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR } from "./fixtures/org.js";
import type { ActionGate } from "../src/kernel/gate.js";

function setup(fullAutonomy: boolean) {
  const config = { ...loadConfig(process.cwd()), fullAutonomy };
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "fa-")), "AIOS");
  const gate = { propose: async () => ({}) } as unknown as ActionGate;
  const registry = loadRegistry(FIXTURE_AGENTS_DIR, FIXTURE_PLAYBOOKS_DIR, buildExtras(config), () => {});
  return { registry, config,
    resolve: makeResolveAgent({ registry, store, vault, gate, config, categorize: async () => "other" as const }) };
}
const origin = { channel: "web", chatId: "ui" };

// Fixture roles: janus/venus/clio (research, no guard, no sandbox), atlas/juno/minos (guarded),
// vulcan/argus (engineering → code-sandbox via dept defaults).
const UNGUARDED = "janus";

describe("AIOS_FULL_AUTONOMY", () => {
  it("default ON: an unset, empty or unrecognised value leaves autonomy on", () => {
    expect(buildConfig({} as NodeJS.ProcessEnv, "/tmp/x").fullAutonomy).toBe(true);
    expect(buildConfig({ AIOS_FULL_AUTONOMY: "" } as never, "/tmp/x").fullAutonomy).toBe(true);
    expect(buildConfig({ AIOS_FULL_AUTONOMY: "1" } as never, "/tmp/x").fullAutonomy).toBe(true);
    expect(buildConfig({ AIOS_FULL_AUTONOMY: "yes" } as never, "/tmp/x").fullAutonomy).toBe(true);
  });

  it("opts out on every ordinary spelling of no — the direction that must never be missed", () => {
    // The old parser was `=== "1"`, so `true` meant OFF. Harmless when the fallback was
    // restriction; a trap now that it is autonomy. Someone writing `false` to lock their agents
    // down must not get the opposite of what they asked for.
    for (const raw of ["0", "false", "no", "off", "FALSE", " Off ", "No"]) {
      expect(buildConfig({ AIOS_FULL_AUTONOMY: raw } as never, "/tmp/x").fullAutonomy, raw).toBe(false);
    }
  });

  it("parseAutonomy is the one place the spellings live", () => {
    expect(parseAutonomy(undefined)).toBe(true);
    expect(parseAutonomy("0")).toBe(false);
    expect(parseAutonomy("true")).toBe(true);
  });

  it("flag on: unguarded non-sandbox agent flips to bypassPermissions with allowDangerouslySkipPermissions", () => {
    const { resolve, registry } = setup(true);
    expect(isGuarded(registry, UNGUARDED)).toBe(false);
    const r = resolve(UNGUARDED, origin)!;
    expect(r.options.permissionMode).toBe("bypassPermissions");
    expect((r.options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions).toBe(true);
  });

  it("flag on: allowedTools and MCP server names are byte-identical to flag-off — enforcement lifts, the surface list never widens", () => {
    const on = setup(true), off = setup(false);
    for (const name of [...on.registry.agents.keys()]) {
      const a = on.resolve(name, origin)!, b = off.resolve(name, origin)!;
      expect([...(a.options.allowedTools ?? [])].sort(), name).toEqual([...(b.options.allowedTools ?? [])].sort());
      expect(Object.keys(a.options.mcpServers ?? {}).sort(), name).toEqual(Object.keys(b.options.mcpServers ?? {}).sort());
    }
  });

  it("flag on: guarded agents resolve bit-identical to flag-off — mode, no skip flag, canUseTool and PreToolUse intact", () => {
    const on = setup(true), off = setup(false);
    for (const name of ["atlas", "juno", "minos"]) {
      expect(isGuarded(on.registry, name), name).toBe(true);
      const a = on.resolve(name, origin)!, b = off.resolve(name, origin)!;
      expect(a.options.permissionMode, name).toBe(b.options.permissionMode);
      expect(a.options.permissionMode, name).not.toBe("bypassPermissions");
      expect((a.options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions, name)
        .toBe((b.options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions);
      expect(typeof a.options.canUseTool, name).toBe("function");
      expect((a.options.hooks?.PreToolUse ?? []).length, name)
        .toBe((b.options.hooks?.PreToolUse ?? []).length);
    }
  });

  it("flag on: sandbox agents keep permissionMode default, no skip flag, and their guard hook", () => {
    const on = setup(true);
    for (const name of ["vulcan", "argus"]) {
      const r = on.resolve(name, origin)!;
      expect(r.options.permissionMode, name).toBe("default");
      expect((r.options as { allowDangerouslySkipPermissions?: boolean }).allowDangerouslySkipPermissions, name).toBeUndefined();
      expect(typeof r.options.canUseTool, name).toBe("function"); // advisory/code guard wired
    }
  });

  it("flag on: withDenialObserver is a structural no-op for the bypass agent, still appends for guarded agents", () => {
    const { resolve } = setup(true);
    const noop = () => {};
    const free = resolve(UNGUARDED, origin)!;
    expect(withDenialObserver(free.options as never, UNGUARDED, noop)).toBe(free.options); // same reference: untouched
    const juno = resolve("juno", origin)!;
    const wrapped = withDenialObserver(juno.options as never, "juno", noop) as typeof juno.options;
    expect((wrapped.hooks?.PreToolUse ?? []).length)
      .toBe((juno.options.hooks?.PreToolUse ?? []).length + 1);
  });

  it("flag on: mail widening still lands — send_mail and ask_mail reach a bypass agent's options", () => {
    const { resolve } = setup(true);
    const r = resolve(UNGUARDED, origin)!;
    const mailbox = { peekInbound: () => ({ block: "", ids: [] }) } as unknown as Mailbox;
    const { options } = withMailOptions(r.options as Parameters<typeof withMailOptions>[0], mailbox, { from: UNGUARDED, origin, goalDepth: 0 } as never);
    expect(options.allowedTools).toContain(MAIL_TOOL);
    expect(options.allowedTools).toContain(ASK_TOOL);
    expect(Object.keys(options.mcpServers ?? {})).toContain("aios-mail");
  });

  it("flag on: money servers stay midas-only", () => {
    const { resolve } = setup(true);
    const midas = resolve("midas", origin)!;
    expect(Object.keys(midas.options.mcpServers ?? {}).some((k) => k.includes("money"))).toBe(true);
    for (const name of ["venus", "janus", "neo"]) {
      const r = resolve(name, origin)!;
      expect(Object.keys(r.options.mcpServers ?? {}).some((k) => k.includes("money")), name).toBe(false);
    }
  });

  it("flag on: clamp companion — allowedTools still equals the capability union (plus ToolSearch)", () => {
    const { resolve, registry } = setup(true);
    const r = resolve(UNGUARDED, origin)!;
    const FQ_BARE = ["recall", "vault_read", "vault_write", "propose_action"];
    const fq = (t: string) => (FQ_BARE.includes(t) ? `mcp__aios-pack__${t}` : t);
    const union = new Set(
      registry.agents.get(UNGUARDED)!.capabilities
        .flatMap((c) => registry.capabilities.get(c)!.tools).map(fq),
    );
    for (const t of r.options.allowedTools ?? []) {
      if (t === "ToolSearch") continue;
      expect(union.has(t), `leaked ${t}`).toBe(true);
    }
  });
});
