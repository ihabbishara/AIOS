import { describe, it, expect } from "vitest";
import { parseFrom, reSubject } from "../src/heartbeat/speculate-email.js";

describe("speculate-email helpers", () => {
  it("parseFrom extracts the bare address", () => {
    expect(parseFrom("Eve Example <eve@example.com>")).toBe("eve@example.com");
    expect(parseFrom("plain@example.com")).toBe("plain@example.com");
    expect(parseFrom("  spaced@example.com  ")).toBe("spaced@example.com");
  });

  it("reSubject adds a de-duplicated Re: prefix", () => {
    expect(reSubject("Lunch?")).toBe("Re: Lunch?");
    expect(reSubject("Re: Lunch?")).toBe("Re: Lunch?");
    expect(reSubject("RE: Lunch?")).toBe("RE: Lunch?");
  });
});
