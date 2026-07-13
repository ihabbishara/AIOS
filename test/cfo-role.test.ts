import { describe, it, expect } from "vitest";
import { roleOf } from "./fixtures/registry.js";
import { parseAddress, isPrivateOrigin, DirectChats } from "../src/agents/direct.js";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { testRegistry } from "./fixtures/registry.js";

const registryNames = [...testRegistry().agentOf.keys()];

const stubResolve = (registry: ReturnType<typeof testRegistry>) =>
  ((name, _origin, _ctx) => {
    const canonical = registry.agentOf.get(name.toLowerCase());
    const def = canonical ? registry.agents.get(canonical) : undefined;
    if (!canonical || !def) return undefined;
    return { canonical, kind: def.kind, def, options: { systemPrompt: "", allowedTools: [] }, ceiling: [], labels: [] };
  }) as import("../src/agents/resolve.js").ResolveAgentFn;

describe("cfo role", () => {
  it("cfo is registered and @cfo is addressable", () => {
    expect(roleOf("cfo")).toBeDefined();
    expect(roleOf("cfo").privateOnly).toBe(true);
    expect(parseAddress("@cfo how much did I spend?", registryNames)).toMatchObject({ role: "cfo", text: "how much did I spend?" });
  });
  it("isPrivateOrigin matches the configured primary chat", () => {
    const primary = { channel: "telegram", chatId: "123" };
    expect(isPrivateOrigin(primary, "telegram", "123")).toBe(true);
    expect(isPrivateOrigin(primary, "telegram", "999")).toBe(false);
    expect(isPrivateOrigin(undefined, "telegram", "123")).toBe(false);
  });

  it("treats the Mission Control web cockpit (web:ui) as a private origin", () => {
    const primary = { channel: "telegram", chatId: "123" };
    // cockpit is private regardless of the configured primary (even when unset)
    expect(isPrivateOrigin(primary, "web", "ui")).toBe(true);
    expect(isPrivateOrigin(undefined, "web", "ui")).toBe(true);
    // other web origins are NOT auto-private — still gated by the primary
    expect(isPrivateOrigin(primary, "web", "packs-view")).toBe(false);
    expect(isPrivateOrigin(primary, "web", "mission-control")).toBe(false);
  });

  it("@cfo alias hits faris and is refused from a group origin", async () => {
    const registry = testRegistry();
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const direct = new DirectChats({
      store,
      bus,
      projectsRoot: "/tmp",
      registry,
      resolveAgent: stubResolve(registry),
      // no primaryChat → group-123 is not a private origin
    });
    // "cfo" is an alias for faris (visibility: private → privateOnly: true)
    const res = await direct.handle("cfo", "telegram", "group-123", "how much did I spend?");
    expect(res.text).toContain("private");
  });
});
