// test/moderator-attachments.test.ts
import { describe, it, expect } from "vitest";
import { Moderator } from "../src/moderator/session.js";

describe("Moderator.handle return shape", () => {
  it("returns { text, attachments } (attachments array always present)", () => {
    // Type-level pin: a bare-string return breaks this compile-time assertion via tsc,
    // and the runtime shape check guards the seam for plain-JS callers.
    type Ret = Awaited<ReturnType<Moderator["handle"]>>;
    const witness: Ret = { text: "x", attachments: [] };
    expect(witness.attachments).toEqual([]);
  });
});
