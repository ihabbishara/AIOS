// test/resolve-agent.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { VaultWriter } from "../src/vault/writer.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { buildExtras } from "../src/agents/registry/extras.js";
import { loadConfig } from "../src/config.js";
import { makeResolveAgent } from "../src/agents/resolve.js";
import type { ActionGate } from "../src/kernel/gate.js";

const golden = JSON.parse(readFileSync("test/fixtures/org-golden.json", "utf8")) as
  Record<string, { tools: string[] }>;

function setup() {
  const config = loadConfig(process.cwd());
  const store = new Store(":memory:");
  const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ra-")), "AIOS");
  const gate = { propose: async () => ({}) } as unknown as ActionGate;
  const registry = loadRegistry("agents", "playbooks", buildExtras(config), () => {});
  return { registry, store, config,
    resolve: makeResolveAgent({ registry, store, vault, gate, config, categorize: async () => "other" as const }) };
}
const origin = { channel: "web", chatId: "ui" };

const FQ_BARE = ["recall", "vault_read", "vault_write", "propose_action"];
const fq = (t: string) => (FQ_BARE.includes(t) ? `mcp__aios-pack__${t}` : t);

describe("resolveAgent", () => {
  it("matches the golden surface for every agent — hermes included (v2 migration landed)", () => {
    const { resolve, registry } = setup();
    for (const name of [...registry.agents.keys()]) {
      const r = resolve(name, origin)!;
      expect([...(r.options.allowedTools ?? [])].sort(), name).toEqual(golden[name].tools);
    }
  });

  it("clamp invariant: no agent ever gains a tool outside its capability union", () => {
    const { resolve, registry } = setup();
    for (const name of [...registry.agents.keys()]) {
      const r = resolve(name, origin)!;
      const union = new Set(
        registry.agents.get(name)!.capabilities
          .flatMap((c) => registry.capabilities.get(c)!.tools)
          .map(fq),
      );
      for (const t of r.options.allowedTools ?? []) {
        if (t === "ToolSearch") continue; // harness plumbing: schema loader, grants no access
        expect(union.has(t), `${name} leaked ${t}`).toBe(true);
      }
    }
  });

  it("every agent carries ToolSearch — deferred-tool schemas must be loadable (odin's WebFetch died deferred)", () => {
    const { resolve, registry } = setup();
    for (const name of [...registry.agents.keys()]) {
      expect(resolve(name, origin)!.options.allowedTools, name).toContain("ToolSearch");
    }
  });

  it("model tiering by kind with caller override losing to manifest model", () => {
    const { resolve, registry } = setup();
    const config = { moderatorModel: "mod-m", specialistModel: "spec-m", criticModel: "crit-m" };
    const store = new Store(":memory:");
    const vault = new VaultWriter(mkdtempSync(join(tmpdir(), "ra2-")), "AIOS");
    const gate = { propose: async () => ({}) } as unknown as ActionGate;
    const resolve2 = makeResolveAgent({
      registry, store, vault, gate,
      config: { ...loadConfig(process.cwd()), ...config },
      categorize: async () => "other" as const,
    });
    const byKind = (k: string) => [...registry.agents.values()].find((a) => a.kind === k && !a.role.model)?.manifest.name;
    const worker = byKind("worker"); const lead = byKind("lead"); const critic = byKind("critic");
    expect(worker && resolve2(worker, origin)!.options.model).toBe("spec-m");
    expect(lead && resolve2(lead, origin)!.options.model).toBe("mod-m");
    expect(critic && resolve2(critic, origin)!.options.model).toBe("crit-m");
    // caller ctx.model beats the tier
    expect(worker && resolve2(worker!, origin, { model: "override-m" })!.options.model).toBe("override-m");
    void resolve; // primary resolver unused here
  });

  it("ceiling and labels are capability unions; unknown agent → undefined", () => {
    const { resolve } = setup();
    expect(resolve("no-such-agent", origin)).toBeUndefined();
    const vulcan = resolve("vulcan", origin)!;
    expect(vulcan.ceiling).toContain("vault.write"); // engineering dept actions via shim capability
    const jasmine = resolve("jasmine", origin)!;
    expect(Array.isArray(jasmine.labels)).toBe(true);
  });

  it("DB revoke row is honored (fail-closed layering preserved)", () => {
    const { resolve, registry, store } = setup();
    const worker = [...registry.agents.values()].find((a) => a.kind === "worker")!.manifest.name;
    const before = resolve(worker, origin)!.options.allowedTools ?? [];
    const victim = before[0];
    store.setRolePermission(worker, victim, 0, "test");
    const after = resolve(worker, origin)!.options.allowedTools ?? [];
    expect(after).not.toContain(victim);
  });

  it("guards survive resolveAgent: halalo keeps its readonly guard, vulcan sandbox confines", () => {
    const { resolve } = setup();
    const halalo = resolve("halalo", origin)!;
    expect(halalo.options.canUseTool).toBeTruthy();
    expect(halalo.options.hooks?.PreToolUse?.length).toBeGreaterThan(0);
    // sandbox dept without a workspace → advisory confinement (permissionMode default)
    const vulcan = resolve("vulcan", origin)!;
    expect(vulcan.options.permissionMode).toBe("default");
    expect(vulcan.options.canUseTool).toBeTruthy();
  });

  it("advisory confinement strips fs/exec but keeps capability-granted web tools (odin borrowed into a workspace-less goal)", async () => {
    const { resolve } = setup();
    const odin = resolve("odin", origin)!;
    expect(odin.options.allowedTools).toContain("WebSearch"); // web capability granted it
    const can = odin.options.canUseTool!;
    const web = await can("WebSearch", { query: "x" }, {} as never);
    expect(web.behavior).toBe("allow");
    const fetch_ = await can("WebFetch", { url: "https://example.com" }, {} as never);
    expect(fetch_.behavior).toBe("allow");
    // fs/exec stay denied outside a workspace
    for (const t of ["Read", "Grep", "Glob", "Write", "Edit", "Bash"]) {
      expect((await can(t, {}, {} as never)).behavior, t).toBe("deny");
    }
  });

  it("SECURITY: atlas keeps its atlas-mutating fence on mcp__code__sh inside a sandbox workspace", async () => {
    const { resolve } = setup();
    // atlas: engineering dept (code-sandbox) + ops-guardrail capability → atlas-mutating guard.
    // The sandbox branch must AND-compose the capability guard, not replace it (the old code
    // dropped atlas-mutating exactly when the workspace gave atlas a shell).
    const ws = mkdtempSync(join(tmpdir(), "atlas-ws-"));
    const atlas = resolve("atlas", origin, { workspace: { taskDir: ws, mode: "build" } })!;
    const can = atlas.options.canUseTool!;
    // mutating shell command → still fenced by atlas-mutating
    const mut = await can("mcp__code__sh", { command: "git push origin main" }, {} as never);
    expect(mut.behavior).toBe("deny");
    // read-only shell command → allowed (codeGuard permits, atlas-mutating permits)
    const ro = await can("mcp__code__sh", { command: "ls -la" }, {} as never);
    expect(ro.behavior).toBe("allow");
  });

  it("media-gen carriers get the media server and its three tools", () => {
    const { resolve } = setup();
    for (const name of ["hermes", "midas", "athena", "odin", "clio", "venus"]) {
      const r = resolve(name, origin)!;
      expect(Object.keys(r.options.mcpServers ?? {}), name).toContain("media");
      for (const t of ["mcp__media__render_chart", "mcp__media__render_diagram", "mcp__media__speak"]) {
        expect(r.options.allowedTools, `${name}:${t}`).toContain(t);
      }
    }
  });

  it("alias resolution works (cfo → midas gets the money server)", () => {
    const { resolve } = setup();
    const r = resolve("cfo", origin)!;
    expect(r.canonical).toBe("midas");
    expect(Object.keys(r.options.mcpServers ?? {})).toContain("money");
    expect(Object.keys(r.options.mcpServers ?? {})).toContain("aios-pack");
  });
});
