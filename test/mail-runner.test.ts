// test/mail-runner.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { loadRegistry } from "../src/agents/registry/loader.js";
import { Mailbox } from "../src/mail/mailbox.js";
import { withMailOptions } from "../src/agents/runner.js";
import { MAIL_TOOL } from "../src/mail/server.js";
import { guardOptions } from "../src/agents/guards/index.js";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

function fixtureRegistry() {
  const root = mkdtempSync(join(tmpdir(), "mr-"));
  const agentsDir = join(root, "agents");
  const eng = join(agentsDir, "engineering");
  mkdirSync(eng, { recursive: true });
  mkdirSync(join(root, "playbooks"), { recursive: true });
  writeFileSync(join(eng, "department.yaml"),
    "department: engineering\nmission: Build.\nlead: athena\nmemoDomain: code\nplaybooks: []\n");
  writeFileSync(join(eng, "vulcan.yaml"),
    "name: vulcan\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  writeFileSync(join(eng, "athena.yaml"),
    "name: athena\ntitle: T\ndepartment: engineering\ncharter: c.\npersona: p.\nprompt: x.\ntools: [Read]\n");
  return loadRegistry(agentsDir, join(root, "playbooks"));
}

const registry = fixtureRegistry();
const CTX = { from: "vulcan", origin: { channel: "telegram", chatId: "1" }, goalDepth: 0 };

function mailbox(store = new Store(":memory:")) {
  return { store, mb: new Mailbox({ store, registry, maxDepth: 2, disabled: false, primaryChat: CTX.origin }) };
}

describe("withMailOptions", () => {
  it("adds server + allowlist entry, preserves existing tools/servers", () => {
    const { mb } = mailbox();
    const base: Options = { allowedTools: ["Read"], mcpServers: {}, systemPrompt: "persona" };
    const { options: out } = withMailOptions(base, mb, CTX);
    expect(out.allowedTools).toContain(MAIL_TOOL);
    expect(out.allowedTools).toContain("Read");
    expect(Object.keys(out.mcpServers ?? {})).toContain("aios-mail");
    expect(base.allowedTools).toEqual(["Read"]); // pure — no mutation
  });

  it("appends unread mail to the system prompt; marks read ONLY once deliveredIds committed", () => {
    const { store, mb } = mailbox();
    store.insertMail({
      id: "n1", from_agent: "athena", to_agent: "vulcan", kind: "note", body: "heads up",
      goal_id: null, origin_channel: "telegram", origin_chat_id: "1", chain_depth: 1, status: "unread", error: null,
    });
    const { options, deliveredIds } = withMailOptions({ systemPrompt: "persona" } as Options, mb, CTX);
    expect(String(options.systemPrompt)).toContain("# Mail");
    expect(String(options.systemPrompt)).toContain("heads up");
    expect(deliveredIds).toEqual(["n1"]);
    expect(store.unreadMailFor("vulcan")).toHaveLength(1); // NOT marked at option assembly (crash-safe)

    mb.markDelivered(deliveredIds); // simulate run success
    expect(store.unreadMailFor("vulcan")).toEqual([]);
    const { options: again } = withMailOptions({ systemPrompt: "persona" } as Options, mb, CTX);
    expect(String(again.systemPrompt)).not.toContain("# Mail");
  });

  it("fallback-deny guards do not block the mail tool (mcp__ passes)", () => {
    const g = guardOptions({}, "deny");
    // canUseTool is the programmatic gate — mcp__ tools must pass a deny-fallback guard
    return (g.canUseTool!(MAIL_TOOL, {}, { signal: new AbortController().signal } as never) as Promise<{ behavior: string }>)
      .then((v) => expect(v.behavior).toBe("allow"));
  });
});
