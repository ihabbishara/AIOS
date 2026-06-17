import { describe, it, expect } from "vitest";
import { roles } from "../src/agents/roles/index.js";
import { parseDirectAddress, isPrivateOrigin } from "../src/agents/direct.js";

describe("cfo role", () => {
  it("cfo is registered and @cfo is addressable", () => {
    expect(roles.cfo).toBeDefined();
    expect(roles.cfo.privateOnly).toBe(true);
    expect(parseDirectAddress("@cfo how much did I spend?")).toMatchObject({ role: "cfo", text: "how much did I spend?" });
  });
  it("isPrivateOrigin matches only the configured primary chat", () => {
    const primary = { channel: "telegram", chatId: "123" };
    expect(isPrivateOrigin(primary, "telegram", "123")).toBe(true);
    expect(isPrivateOrigin(primary, "telegram", "999")).toBe(false);
    expect(isPrivateOrigin(undefined, "telegram", "123")).toBe(false);
  });
});
