// ui2/test/library-render.test.tsx — the Library: a wiki reading room with the record kept as
// an archive. Every file it shows was written by an agent from model output, so "never becomes
// markup" is still the rule the whole view is built around and the thing these tests pin.
//
// Markdown now renders through lib/markdown.tsx instead of a <pre>. That is a presentation
// change, NOT a safety change: the shared renderer builds React nodes and never touches
// innerHTML, so agent-authored angle brackets stay literal either way. The injection tests
// below are the proof and must never be relaxed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { Library, resolveRel } from "../src/views/Library.js";
import { App } from "../src/App.js";
import { BottomTabs } from "../src/components/BottomTabs.js";
import { SECTIONS } from "../src/lib/router.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

const TREE = [
  {
    name: "goals", path: "goals", dir: true, size: 0, mtime: "2026-08-01T00:00:00.000Z",
    children: [{ name: "report.md", path: "goals/report.md", dir: false, size: 12, mtime: "2026-08-01T00:00:00.000Z" }],
  },
  { name: "diagram.svg", path: "diagram.svg", dir: false, size: 40, mtime: "2026-08-01T00:00:00.000Z" },
];

const page = (section: string, name: string, over: Record<string, unknown> = {}) => ({
  name, path: `wiki/${section}/${name}.md`, section,
  title: name, type: section.replace(/s$/, ""), updated: "2026-08-09T00:00:00.000Z",
  outbound: [], backlinks: [], ...over,
});

const WIKI = {
  sections: [
    { name: "topics", pages: [page("topics", "Couscous", { outbound: ["Algeria"], title: "Couscous export economics" })] },
    { name: "entities", pages: [page("entities", "Algeria", { backlinks: ["Couscous"] })] },
    { name: "analyses", pages: [] },
  ],
  index: "index.md", log: "log.md",
  totals: { pages: 2, links: 1, orphans: 1, deadEnds: 1 },
  broken: [],
};

/** file: string → served as that file's bytes; object → served as a JSON refusal with a status. */
function stubLibrary(file: string | { status: number; error: string }, wiki: unknown = WIKI) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/library/tree")) return new Response(JSON.stringify({ nodes: TREE }), { status: 200 });
    if (url.startsWith("/api/library/wiki")) return new Response(JSON.stringify(wiki), { status: 200 });
    if (url.startsWith("/api/library/search")) return new Response(JSON.stringify({ q: "", hits: [] }), { status: 200 });
    if (url.startsWith("/api/library/file")) {
      return typeof file === "string"
        ? new Response(file, { status: 200 })
        : new Response(JSON.stringify({ error: file.error }), { status: file.status });
    }
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  }));
}

/** The archive tree is only fetched once the archive tab is opened, so every record-file test
 *  has to get there first. */
async function openArchive() {
  fireEvent.click(await screen.findByText("archive"));
}

describe("Library — safety (agent output is never markup)", () => {
  // A renderer feeding dangerouslySetInnerHTML would make any agent-written note a
  // script-injection path into the cockpit. This holds on BOTH render paths.
  it("never injects markup — HTML inside a record file stays literal", async () => {
    stubLibrary('# Notes\n\n<img src=x onerror=alert(1)>\n<script>alert(document.cookie)</script>');
    const { container } = render(<Library />);
    await openArchive();
    fireEvent.click(await screen.findByText("report.md"));
    await screen.findByText(/Notes/);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("never injects markup on the WIKI path either", async () => {
    stubLibrary('# Page\n\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>');
    const { container } = render(<Library />);
    fireEvent.click(await screen.findByText("Couscous"));
    await screen.findByText(/Page/);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  // The server echoes the caller's own path back in its refusals, so the error slot is attacker-
  // influenced text and must be rendered as text.
  it("shows a refusal as text, not as markup", async () => {
    stubLibrary({ status: 404, error: "path escapes the workspace: <img src=x onerror=alert(1)>" });
    const { container } = render(<Library />);
    await openArchive();
    fireEvent.click(await screen.findByText("report.md"));
    await screen.findByText(/path escapes the workspace/);
    expect(container.querySelector("img")).toBeNull();
  });

  it("offers an .svg as a download rather than rendering it", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => "blob:stub", revokeObjectURL: () => {},
    }));
    stubLibrary('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { container } = render(<Library />);
    await openArchive();
    fireEvent.click(await screen.findByText("diagram.svg"));
    const link = (await screen.findByText("Download")) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("download")).toBe("diagram.svg");
    // Not an <img>/<embed>: SVG in either would execute in the cockpit's origin.
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(container.querySelector("embed")).toBeNull();
  });

  it("a truncated .pdf says so instead of rendering a broken viewer", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => "blob:stub", revokeObjectURL: () => {},
    }));
    // The real 57-byte stub a failed render left in the vault. Its %PDF header is enough for
    // the server to type it application/pdf, so it used to reach an <embed>.
    stubLibrary("%PDF-1.7 binary payload — cannot be represented as text");
    const tree = [{ name: "deck.pdf", path: "deck.pdf", dir: false, size: 57, mtime: "2026-08-01T00:00:00.000Z" }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/library/tree")) return new Response(JSON.stringify({ nodes: tree }), { status: 200 });
      if (url.startsWith("/api/library/wiki")) return new Response(JSON.stringify(WIKI), { status: 200 });
      return new Response("%PDF-1.7 binary payload — cannot be represented as text", { status: 200 });
    }));
    const { container } = render(<Library />);
    await openArchive();
    fireEvent.click(await screen.findByText("deck.pdf"));
    expect(await screen.findByText(/no PDF end marker/)).toBeTruthy();
    expect(container.querySelector("embed")).toBeNull();
    // Still reachable — the bytes are the user's, however broken.
    expect(screen.getByText("Download it anyway")).toBeTruthy();
  });

  it("a well-formed .pdf still renders in the viewer", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => "blob:stub", revokeObjectURL: () => {},
    }));
    const tree = [{ name: "real.pdf", path: "real.pdf", dir: false, size: 400, mtime: "2026-08-01T00:00:00.000Z" }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/library/tree")) return new Response(JSON.stringify({ nodes: tree }), { status: 200 });
      if (url.startsWith("/api/library/wiki")) return new Response(JSON.stringify(WIKI), { status: 200 });
      return new Response("%PDF-1.7\n...body...\ntrailer\n%%EOF\n", { status: 200 });
    }));
    const { container } = render(<Library />);
    await openArchive();
    fireEvent.click(await screen.findByText("real.pdf"));
    await waitFor(() => expect(container.querySelector("embed")).toBeTruthy());
  });

  it("a non-markdown text file keeps its exact bytes in a <pre>", async () => {
    stubLibrary('{"a": 1}');
    render(<Library />);
    await openArchive();
    // Only .md goes through the prose renderer; everything else stays verbatim.
    const tree = [{ name: "data.json", path: "data.json", dir: false, size: 8, mtime: "2026-08-01T00:00:00.000Z" }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/library/tree")) return new Response(JSON.stringify({ nodes: tree }), { status: 200 });
      if (url.startsWith("/api/library/wiki")) return new Response(JSON.stringify(WIKI), { status: 200 });
      return new Response('{"a": 1}', { status: 200 });
    }));
    cleanup();
    render(<Library />);
    await openArchive();
    fireEvent.click(await screen.findByText("data.json"));
    const pre = await screen.findByText(/"a": 1/);
    expect(pre.tagName).toBe("PRE");
  });
});

describe("Library — the reading room", () => {
  it("opens on the wiki with its sections and counts, not on the file tree", async () => {
    stubLibrary("# Couscous export economics");
    render(<Library />);
    expect(await screen.findByText("topics")).toBeTruthy();
    expect(screen.getByText("entities")).toBeTruthy();
    // An empty section stays visible so its emptiness is a fact rather than an absence.
    expect(screen.getByText("analyses")).toBeTruthy();
    expect(screen.getByText("none yet")).toBeTruthy();
    // The header states the graph, which is the wiki's health at a glance.
    expect(screen.getByText(/2 pages · 1 links/)).toBeTruthy();
  });

  it("shows a page's type, freshness and link counts above the prose", async () => {
    stubLibrary("# Couscous export economics\n\nbody");
    render(<Library />);
    fireEvent.click(await screen.findByText("Couscous"));
    await screen.findByText(/body/);
    expect(screen.getByText("topic")).toBeTruthy();
    expect(screen.getByText("updated 2026-08-09")).toBeTruthy();
    expect(screen.getByText("1 out · 0 in")).toBeTruthy();
  });

  it("a [[wikilink]] in the prose navigates to that page", async () => {
    stubLibrary("# Couscous\n\nGrown in [[Algeria]] mostly.");
    render(<Library />);
    fireEvent.click(await screen.findByText("Couscous"));
    const link = await screen.findByRole("button", { name: "Algeria" });
    await act(async () => { fireEvent.click(link); });
    // The reader switched pages: Algeria's own backlink panel is what proves it.
    await waitFor(() => expect(screen.getByText("Linked from")).toBeTruthy());
  });

  it("renders [[Page|alias]] as the alias, and leaves [[#anchor]] literal", async () => {
    stubLibrary("# Couscous\n\nSee [[Algeria|the country]] and [[#Resolution]].");
    render(<Library />);
    fireEvent.click(await screen.findByText("Couscous"));
    expect(await screen.findByRole("button", { name: "the country" })).toBeTruthy();
    // An intra-page anchor is not a page — it must not become a dead button.
    expect(screen.queryByRole("button", { name: "#Resolution" })).toBeNull();
    await waitFor(() => expect(screen.getByText(/\[\[#Resolution\]\]/)).toBeTruthy());
  });

  it("names an orphan as a bug rather than showing an empty panel", async () => {
    stubLibrary("# Couscous\n\nbody");
    render(<Library />);
    fireEvent.click(await screen.findByText("Couscous")); // backlinks: []
    expect(await screen.findByText(/this page is an orphan/)).toBeTruthy();
  });

  it("resolveRel turns a page-relative link into a vault path", () => {
    // The form all 22 live source pages use.
    expect(resolveRel("wiki/sources/Marseille.md", "../../knowledge/marseille.md"))
      .toBe("knowledge/marseille.md");
    expect(resolveRel("wiki/topics/A.md", "./B.md")).toBe("wiki/topics/B.md");
    // Climbing past the vault root resolves to nothing rather than a request certain to 404.
    expect(resolveRel("wiki/sources/X.md", "../../../../etc/passwd")).toBe(null);
  });

  it("a [record](../..) link jumps to the archive with that file open", async () => {
    stubLibrary("# Couscous\n\n[record](../../goals/report.md) — researched 2026-07-16.");
    render(<Library />);
    fireEvent.click(await screen.findByText("Couscous"));
    const link = await screen.findByRole("button", { name: "record" });
    await act(async () => { fireEvent.click(link); });
    // Landing in the archive is the point: record files live there, not in the wiki nav.
    await waitFor(() => expect(screen.getByText("the record — read-only")).toBeTruthy());
  });

  it("the wiki totals never sit over the archive claiming to describe it", async () => {
    stubLibrary("# x");
    render(<Library />);
    expect(await screen.findByText(/2 pages · 1 links/)).toBeTruthy();
    await openArchive();
    expect(screen.getByText("the record — read-only")).toBeTruthy();
    expect(screen.queryByText(/2 pages · 1 links/)).toBeNull();
  });

  it("offers a way back to the index on phones, where the index is hidden", async () => {
    stubLibrary("# Couscous\n\nbody");
    render(<Library />);
    // Nothing picked: no back control, because the index is what is showing.
    expect(screen.queryByText(/← All pages/)).toBeNull();
    fireEvent.click(await screen.findByText("Couscous"));
    const back = await screen.findByText("← All pages");
    await act(async () => { fireEvent.click(back); });
    await waitFor(() => expect(screen.getByText("Pick a page.")).toBeTruthy());
  });

  it("lists backlinks and follows one", async () => {
    stubLibrary("# Algeria\n\nbody");
    render(<Library />);
    fireEvent.click(await screen.findByText("Algeria"));
    await screen.findByText("Linked from");
    // Scoped to the panel: the sidebar carries a "Couscous" button too.
    const back = within(screen.getByTestId("backlinks")).getByRole("button", { name: "Couscous" });
    await act(async () => { fireEvent.click(back); });
    await waitFor(() => expect(screen.getByText(/this page is an orphan/)).toBeTruthy());
  });
});

describe("Library — search", () => {
  function stubSearch(hits: unknown[]) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/library/wiki")) return new Response(JSON.stringify(WIKI), { status: 200 });
      if (url.startsWith("/api/library/search")) return new Response(JSON.stringify({ q: "x", hits }), { status: 200 });
      if (url.startsWith("/api/library/tree")) return new Response(JSON.stringify({ nodes: TREE }), { status: 200 });
      return new Response("# body", { status: 200 });
    }));
  }

  it("labels every hit by layer so wiki and record are never confused", async () => {
    stubSearch([
      { path: "wiki/topics/Couscous.md", title: "Couscous", snippet: "semolina", score: 9, ts: "2026-08-09T00:00:00.000Z", wiki: true },
      { path: "goals/x/report.md", title: "report", snippet: "shipping", score: 4, ts: "2026-08-01T00:00:00.000Z", wiki: false },
    ]);
    render(<Library />);
    await screen.findByText("topics");
    fireEvent.change(screen.getByLabelText("Search the vault"), { target: { value: "semolina" } });
    // Gate on the count, never on the "wiki" tag — the segmented control has a tab of the same
    // name, so getByText("wiki") resolves instantly against it and the assertion runs too early.
    await waitFor(() => expect(screen.getByText(/2 results for/)).toBeTruthy());
    expect(screen.getByText("wiki/topics/Couscous.md")).toBeTruthy();
    expect(screen.getByText("goals/x/report.md")).toBeTruthy();
    expect(screen.getByText("record")).toBeTruthy();
  });

  it("an empty result set says what to do next", async () => {
    stubSearch([]);
    render(<Library />);
    await screen.findByText("topics");
    fireEvent.change(screen.getByLabelText("Search the vault"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/Nothing matched/)).toBeTruthy());
  });

  it("clearing the box returns to browsing rather than stranding the reader", async () => {
    stubSearch([]);
    render(<Library />);
    const box = await screen.findByLabelText("Search the vault");
    fireEvent.change(box, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/Nothing matched/)).toBeTruthy());
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("topics")).toBeTruthy());
  });
});

// Registration is four separate edits (SECTIONS, ICONS, JUMPS, the App row) and missing any one
// leaves the view unreachable or tab-less rather than broken — nothing else would go red.
describe("Library nav registration", () => {
  it("gives every section a phone tab with an icon", () => {
    const { container } = render(<BottomTabs section="home" needsYou={0} />);
    for (const s of SECTIONS) {
      const tab = container.querySelector(`a[href="#/${s}"]`);
      expect(tab, `${s} has no bottom tab`).toBeTruthy();
      expect(tab!.querySelector("span")!.textContent, `${s} tab renders a blank icon`).not.toBe("");
    }
  });

  it("jumps to the section on the g-l chord", async () => {
    stubApi({ "/api/state": STATE_STUB, "/api/attention": [], "/api/library/wiki": WIKI });
    render(<App />);
    await screen.findByText("Library");
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "l" });
    expect(window.location.hash).toBe("#/library");
  });

  it("mounts Library in the shell and shows it on #/library", async () => {
    window.location.hash = "#/library";
    stubApi({
      "/api/state": STATE_STUB, "/api/budget": { date: "2026-08-01", spentCents: 0, capCents: 1000 },
      "/api/attention": [], "/api/mail/unread": { total: 0, byAgent: {}, pendingUser: 0, userInbox: 0 },
      "/api/library/wiki": WIKI,
    });
    render(<App />);
    const heading = await screen.findByText("Library"); // the h1, not the lowercase tab label
    expect(heading.closest("div.hidden"), "the library section renders hidden on its own route").toBeNull();
  });
});
