// test/state-capabilities.test.ts — /api/state feeds the capability CHECKBOXES in ui2's hire and
// new-department forms (Staff.tsx). Client-scoped rows are one user's integration: the architect
// paths already filtered them via productCapabilities, but this endpoint handed back the raw
// catalogue, so a brand-new install offered a tickable box for another user's client. Ticking it
// resolves a guard that throws for want of that client's env var.
//
// Synthetic capabilities on purpose: pinning the real client row would rot the moment it is
// renamed, and the property under test is the label filter, not the name.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type WebDeps } from "../src/web/server.js";
import { loadRegistry } from "../src/agents/registry/loader.js";

const TOKEN = "state-token";
let root: string, server: Server, port: number, prevToken: string | undefined;

beforeEach(async () => {
  prevToken = process.env.AIOS_UI_TOKEN;
  process.env.AIOS_UI_TOKEN = TOKEN;
  root = mkdtempSync(join(tmpdir(), "state-caps-"));
  const agentsDir = join(root, "agents");
  const playbooksDir = join(root, "playbooks");
  mkdirSync(playbooksDir, { recursive: true });
  mkdirSync(join(agentsDir, "ops"), { recursive: true });

  writeFileSync(join(agentsDir, "_capabilities.yaml"),
    "vault-read: { tools: [vault_read], labels: [general] }\n" +
    "acme-crm:   { tools: [mcp__acme__crm], labels: [client.acme] }\n");
  writeFileSync(join(agentsDir, "ops", "department.yaml"),
    "department: ops\nmission: Do ops.\nlead: nova\nmemoDomain: general\ncapabilities: []\nplaybooks: []\n");
  writeFileSync(join(agentsDir, "ops", "nova.yaml"),
    "name: nova\ntitle: T\ndepartment: ops\ncharter: c.\npersona: p.\nprompt: x.\nkind: coordinator\ncapabilities: []\n");

  const deps = {
    store: {}, bus: {}, vault: {}, router: {}, gate: {}, mailbox: {},
    voice: { available: () => false },
    goals: { listPlaybooks: () => [] },
    registry: loadRegistry(agentsDir, playbooksDir),
    config: { dbPath: ":memory:", agentsDir, playbooksDir, chatBindings: new Map() },
    reloadPacks: () => {},
    envPath: "", uiDist: "", log: () => {},
  } as unknown as WebDeps;

  server = startWebServer(deps, 0);
  if (!server.listening) await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (prevToken === undefined) delete process.env.AIOS_UI_TOKEN;
  else process.env.AIOS_UI_TOKEN = prevToken;
});

const state = async (): Promise<{ capabilities: string[] }> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ capabilities: string[] }>;
};

describe("GET /api/state capabilities", () => {
  it("never offers a client-scoped capability", async () => {
    expect((await state()).capabilities).not.toContain("acme-crm");
  });

  // Guards the filter against being over-broad: dropping everything would pass the test above.
  it("still offers product capabilities", async () => {
    expect((await state()).capabilities).toContain("vault-read");
  });
});
