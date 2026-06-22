// test/packs-toggle.test.ts
import { describe, it, expect } from "vitest";
import { packDisableKey } from "../src/web/packs-view.js";

describe("packDisableKey", () => {
  it("maps a pillar to its disable env key (matches the boot kill-switch pattern)", () => {
    expect(packDisableKey("code")).toBe("AIOS_CODE_DISABLED");
    expect(packDisableKey("money")).toBe("AIOS_MONEY_DISABLED");
  });
});
