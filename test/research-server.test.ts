// test/research-server.test.ts
//
// Unit tests for the research MCP tool server built by buildResearchServer.
// Drives tool handlers directly via the SDK McpServer's internal
// _registeredTools registry — the same pattern used in attachment-server.test.ts.

import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { buildResearchServer } from "../src/research/server.js";

/**
 * Extract a named tool handler from the SDK MCP server returned by
 * buildResearchServer.  Mirrors the pattern in test/attachment-server.test.ts:
 *   server = { type: "sdk", name: "...", instance: McpServer }
 *   McpServer._registeredTools is the internal tool registry.
 */
function getHandler(
  server: ReturnType<typeof buildResearchServer>,
  toolName: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
  const inst = (server as unknown as {
    instance: { _registeredTools: Record<string, { handler: unknown }> };
  }).instance;
  const registered = inst._registeredTools[toolName];
  if (!registered || typeof registered.handler !== "function") {
    throw new Error(`Tool "${toolName}" not found in server._registeredTools`);
  }
  return registered.handler as ReturnType<typeof getHandler>;
}

describe("research MCP server", () => {
  it("save_source persists, list_sources + search_sources read it back", async () => {
    const store = new Store(":memory:");
    const server = buildResearchServer({ store });

    const save = getHandler(server, "save_source");
    const list = getHandler(server, "list_sources");
    const search = getHandler(server, "search_sources");

    await save({ url: "https://x.com", title: "X", topic: "ai", note: "interesting" });

    const listResult = await list({});
    expect(listResult.content[0].text).toContain("https://x.com");
    expect(listResult.content[0].text).toContain("[ai]");

    const searchResult = await search({ query: "x" });
    expect(searchResult.content[0].text).toContain("https://x.com");
  });

  it("list_sources filters by topic", async () => {
    const store = new Store(":memory:");
    const server = buildResearchServer({ store });
    const save = getHandler(server, "save_source");
    const list = getHandler(server, "list_sources");

    await save({ url: "https://ai.com", title: "AI Paper", topic: "ai", note: null });
    await save({ url: "https://bio.com", title: "Bio Paper", topic: "biology", note: null });

    const aiOnly = await list({ topic: "ai" });
    expect(aiOnly.content[0].text).toContain("https://ai.com");
    expect(aiOnly.content[0].text).not.toContain("https://bio.com");
  });

  it("search_sources returns no results for an unmatched query", async () => {
    const store = new Store(":memory:");
    const server = buildResearchServer({ store });
    const search = getHandler(server, "search_sources");

    const result = await search({ query: "zzznomatch" });
    expect(result.content[0].text).toBe("(none)");
  });

  it("exposes exactly the three expected tools", () => {
    const store = new Store(":memory:");
    const server = buildResearchServer({ store });
    const inst = (server as unknown as {
      instance: { _registeredTools: Record<string, unknown> };
    }).instance;
    const names = Object.keys(inst._registeredTools).sort();
    expect(names).toEqual(["list_sources", "save_source", "search_sources"]);
  });
});
