// test/packs-toggle.test.ts
import { describe, it, expect } from "vitest";
import { packDisableKey } from "../src/web/packs-view.js";

describe("packDisableKey", () => {
  it("maps a pillar to its disable env key (matches the boot kill-switch pattern)", () => {
    expect(packDisableKey("engineering")).toBe("AIOS_ENGINEERING_DISABLED");
    expect(packDisableKey("finance")).toBe("AIOS_FINANCE_DISABLED");
  });
});
