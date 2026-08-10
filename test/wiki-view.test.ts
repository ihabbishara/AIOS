// test/wiki-view.test.ts — the Library's reading room: wiki structure, the link graph in both
// directions, and search over the index the agents already use.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store/db.js";
import { indexDoc, recall } from "../src/memory/recall.js";
import {
  buildWikiView, parseWikilinks, frontmatterType, pageTitle, searchLibrary,
} from "../src/web/wiki-view.js";

let root: string;

const page = (section: string, name: string, body: string) =>
  writeFileSync(join(root, "wiki", section, `${name}.md`), body);

beforeEach(() => {
  root = join(mkdtempSync(join(tmpdir(), "wiki-")), "vault");
  for (const s of ["topics", "concepts", "entities", "sources", "analyses"]) {
    mkdirSync(join(root, "wiki", s), { recursive: true });
  }
  mkdirSync(join(root, "goals"), { recursive: true });
  writeFileSync(join(root, "index.md"), "# Index");
  writeFileSync(join(root, "log.md"), "# Log");
});

describe("parseWikilinks", () => {
  it("reads [[Page]] and [[Page|alias]], dedupes, keeps first-appearance order", () => {
    expect(parseWikilinks("see [[Beta]] and [[Alpha|the first]] and [[Beta]] again"))
      .toEqual(["Beta", "Alpha"]);
  });

  it("refuses a link wrapped across a line break, exactly as the renderer does", () => {
    // The schema bans this because such a link renders as literal text and the edge is lost.
    // A parser that resolved it would report a graph the reader cannot reproduce.
    expect(parseWikilinks("[[Some Long Page\nName]]")).toEqual([]);
  });

  it("drops [[#anchor]] — an intra-page ref is not an edge", () => {
    // Validated against the live wiki: this is the ONLY one of 3274 links that fails to
    // resolve to a page, and counting it as broken would report a false defect forever.
    expect(parseWikilinks("jump to [[#Resolution (2026-08-10)]] and [[Real Page]]"))
      .toEqual(["Real Page"]);
  });
});

describe("frontmatterType / pageTitle", () => {
  it("reads type out of frontmatter and strips quotes", () => {
    expect(frontmatterType('---\ntype: topic\ntags: [a]\n---\n\n# T')).toBe("topic");
    expect(frontmatterType('---\ntype: "entity"\n---\n')).toBe("entity");
    expect(frontmatterType("# No frontmatter")).toBe(null);
  });

  it("titles on the first heading, never on one inside frontmatter", () => {
    expect(pageTitle("---\nsources: [\"# not a title\"]\n---\n\n# Real Title\n", "fb")).toBe("Real Title");
    expect(pageTitle("no heading here", "Fallback Name")).toBe("Fallback Name");
  });
});

describe("buildWikiView", () => {
  it("discovers sections and pages, with paths /api/library/file can serve", () => {
    page("topics", "Couscous Export", "---\ntype: topic\n---\n\n# Couscous export economics\n\nsee [[Algeria]]");
    page("entities", "Algeria", "---\ntype: entity\n---\n\n# Algeria\n\nback to [[Couscous Export]]");
    const v = buildWikiView(root);

    expect(v.sections.map((s) => s.name)).toEqual(["analyses", "concepts", "entities", "sources", "topics"]);
    const topic = v.sections.find((s) => s.name === "topics")!.pages[0];
    expect(topic).toMatchObject({
      name: "Couscous Export",
      path: "wiki/topics/Couscous Export.md",
      section: "topics",
      title: "Couscous export economics",
      type: "topic",
    });
    expect(v.index).toBe("index.md");
    expect(v.log).toBe("log.md");
  });

  it("builds the link graph in BOTH directions", () => {
    page("topics", "Hub", "# Hub\n\n[[Leaf A]] and [[Leaf B]]");
    page("entities", "Leaf A", "# Leaf A\n\nback to [[Hub]]");
    page("entities", "Leaf B", "# Leaf B\n\nback to [[Hub]]");
    const v = buildWikiView(root);
    const byName = new Map(v.sections.flatMap((s) => s.pages).map((p) => [p.name, p]));

    expect(byName.get("Hub")!.outbound).toEqual(["Leaf A", "Leaf B"]);
    expect(byName.get("Hub")!.backlinks).toEqual(["Leaf A", "Leaf B"]);
    expect(byName.get("Leaf A")!.backlinks).toEqual(["Hub"]);
    expect(v.totals).toMatchObject({ pages: 3, orphans: 0, deadEnds: 0 });
    expect(v.broken).toEqual([]);
  });

  it("a self-link is not an edge — a page must not be its own backlink", () => {
    page("topics", "Solo", "# Solo\n\nI mention [[Solo]] and [[Other]]");
    page("entities", "Other", "# Other\n\nsee [[Solo]]");
    const v = buildWikiView(root);
    const solo = v.sections.flatMap((s) => s.pages).find((p) => p.name === "Solo")!;
    expect(solo.outbound).toEqual(["Other"]);
    expect(solo.backlinks).toEqual(["Other"]);
  });

  it("reports orphans, dead ends and broken links instead of hiding them", () => {
    // All three are bugs by the wiki schema, so the reader has to be able to show them.
    page("topics", "Dangler", "# Dangler\n\npoints at [[Nothing Here]]");
    page("concepts", "Lonely", "# Lonely\n\nno links at all");
    const v = buildWikiView(root);

    expect(v.broken).toEqual([{ from: "Dangler", link: "Nothing Here" }]);
    expect(v.totals.orphans).toBe(2); // neither page is linked TO
    // BOTH are dead ends: a page whose only link is broken has no working exit, so counting
    // dead ends on RESOLVED outbound (not on raw `[[...]]` occurrences) is the honest measure.
    // Dangler is therefore reported twice — once as a bad link, once as a page you cannot leave.
    expect(v.totals.deadEnds).toBe(2);
    expect(v.totals.links).toBe(1); // links counts attempts, so the broken one is visible here
  });

  it("a missing vault or missing wiki/ is empty, not a throw", () => {
    expect(buildWikiView(join(root, "nope")).totals.pages).toBe(0);
    const bare = mkdtempSync(join(tmpdir(), "bare-"));
    expect(buildWikiView(bare)).toMatchObject({ sections: [], index: null, log: null });
  });
});

describe("searchLibrary", () => {
  const doc = (store: Store, ref: string, title: string, body: string) =>
    indexDoc(store, {
      source: "vault", ref, domain: "general", title, body,
      ts: "2026-08-01T00:00:00.000Z", fingerprint: ref,
    });

  it("returns vault paths the file endpoint can serve, flagging wiki hits", () => {
    const store = new Store(":memory:");
    doc(store, "wiki/topics/Couscous Export.md", "Couscous Export", "semolina tonnage and export economics");
    doc(store, "goals/2026-08-01-x/report.md", "report", "unrelated shipping note");
    const hits = searchLibrary(store, "semolina tonnage");

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ path: "wiki/topics/Couscous Export.md", title: "Couscous Export", wiki: true });
  });

  it("drops non-vault docs — mail and events have no library path to open", () => {
    const store = new Store(":memory:");
    indexDoc(store, {
      source: "mail", ref: "thread:abc", domain: "inbox", title: "m", body: "semolina tonnage",
      ts: "2026-08-01T00:00:00.000Z", fingerprint: "m1",
    });
    expect(searchLibrary(store, "semolina tonnage")).toEqual([]);
  });

  it("an empty query is empty, not everything", () => {
    const store = new Store(":memory:");
    doc(store, "wiki/topics/A.md", "A", "content");
    expect(searchLibrary(store, "   ")).toEqual([]);
  });

  it("does NOT count as use — cockpit browsing must not pollute the readership evidence", () => {
    // memory_use is the measurement that showed 308 of 324 hits landing on knowledge/, which
    // is why the wiki exists; last_retrieved_at drives the 180-day stale penalty. A human
    // browsing would silently corrupt both.
    const store = new Store(":memory:");
    doc(store, "wiki/topics/Couscous Export.md", "Couscous Export", "semolina tonnage");
    expect(searchLibrary(store, "semolina tonnage").length).toBeGreaterThan(0);
    const uses = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
      .prepare("SELECT COUNT(*) c FROM memory_use").get() as { c: number };
    expect(uses.c).toBe(0);

    // ...while an ordinary agent recall still does, so the option narrows nothing else.
    recall(store, "semolina tonnage");
    const after = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db
      .prepare("SELECT COUNT(*) c FROM memory_use").get() as { c: number };
    expect(after.c).toBe(1);
  });
});
