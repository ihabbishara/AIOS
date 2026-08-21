// ui2/test/frontmatter.test.ts — the massive-heading bug: a vault artifact's frontmatter must
// come OFF the markdown body, and anything ambiguous must pass through untouched.
import { describe, it, expect } from "vitest";
import { splitFrontmatter } from "../src/lib/frontmatter.js";

const DOC = `---
created: "2026-08-19T11:46:03.163Z"
node: "assemble-final-report"
role: "clio"
approved-with-waiver: true
objections: "Section 1 misrepresents FRANSAT PRO cards. RESOLUTION: fix it."
---

Done. The deliverable is written.

## What happened
`;

describe("splitFrontmatter", () => {
  it("splits the shipped shape: keys parsed, quotes stripped, body starts at the document", () => {
    const { meta, body } = splitFrontmatter(DOC);
    expect(meta!.map((m) => m.key)).toEqual(["created", "node", "role", "approved-with-waiver", "objections"]);
    expect(meta!.find((m) => m.key === "role")!.value).toBe("clio");
    expect(body.startsWith("Done. The deliverable")).toBe(true);
    expect(body).not.toContain("---");
  });

  it("no frontmatter → untouched", () => {
    const { meta, body } = splitFrontmatter("# Title\n\nText.");
    expect(meta).toBeNull();
    expect(body).toBe("# Title\n\nText.");
  });

  it("an unclosed block is content, not metadata", () => {
    const src = "---\nkey: value\nnever closes";
    expect(splitFrontmatter(src)).toEqual({ meta: null, body: src });
  });

  it("a thematic break mid-document is not frontmatter", () => {
    const src = "Intro paragraph.\n\n---\n\nMore text.";
    expect(splitFrontmatter(src).meta).toBeNull();
  });

  it("continuation lines fold into the previous value", () => {
    const { meta } = splitFrontmatter('---\nobjections: "first part\nsecond part"\n---\nBody');
    expect(meta![0].value).toContain("first part");
    expect(meta![0].value).toContain("second part");
  });
});
