import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";
import { parseDirectAddress, isPrivateOrigin } from "../src/agents/direct.js";

describe("cfo role", () => {
  it("cfo is registered and @cfo is addressable", () => {
    expect(roles.cfo).toBeDefined();
    expect(roles.cfo.privateOnly).toBe(true);
    expect(parseDirectAddress("@cfo how much did I spend?")).toMatchObject({ role: "cfo", text: "how much did I spend?" });
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
});
