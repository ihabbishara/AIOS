// ui2/test/router.test.ts
import { describe, it, expect } from "vitest";
import { parseHash, href } from "../src/lib/router.js";

describe("router", () => {
  it("defaults to home", () => {
    expect(parseHash("").section).toBe("home");
    expect(parseHash("#/inbox").section).toBe("home"); // old-UI paths fall back calmly
  });
  it("parses section, parts, query", () => {
    const r = parseHash("#/goals/my-slug?tab=nodes");
    expect(r.section).toBe("goals");
    expect(r.parts).toEqual(["my-slug"]);
    expect(r.query.get("tab")).toBe("nodes");
  });
  it("decodes segments and builds hrefs", () => {
    expect(parseHash("#/staff/agents/a%20b").parts).toEqual(["agents", "a b"]);
    expect(href("goals/x")).toBe("#/goals/x");
    expect(href("#/goals/x")).toBe("#/goals/x");
  });
  it("schedule is a section", () => {
    expect(parseHash("#/schedule").section).toBe("schedule");
  });
  it("skills is a section", () => {
    expect(parseHash("#/skills").section).toBe("skills");
  });
});
