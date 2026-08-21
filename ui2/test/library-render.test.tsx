// ui2/test/library-render.test.tsx — the Library as the shelf: what the org produced, newest
// first. The wiki taxonomy and the raw archive tree are gone from the front door; what these
// tests pin instead is (1) the shelf's boundary — deliverables and standalone docs, engine
// residue already filtered server-side, (2) the reading path staying injection-safe: every file
// here was written by an agent from model output, so "never becomes markup" is still the rule,
// and (3) the deploy seam — dist goes live before the daemon restarts, so a missing shelf
// endpoint must say "restart", never render as an empty library.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Library } from "../src/views/Library.js";
import { App } from "../src/App.js";
import { BottomTabs } from "../src/components/BottomTabs.js";
import { SECTIONS } from "../src/lib/router.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

const file = (name: string, over: Record<string, unknown> = {}) => ({
  name, path: `goals/2026-08-19-hotel-tv/${name}`, size: 12000,
  mtime: "2026-08-19T09:00:00.000Z", ...over,
});

const WORK = {
  id: "g1", slug: "hotel-tv", title: "Hotel TV systems report", department: "research",
  lead: "clio", status: "done", finishedAt: "2026-08-19T10:00:00.000Z",
  headline: "final-report.md",
  files: [file("angle-1.md"), file("final-report.md", { mtime: "2026-08-19T10:00:00.000Z" })],
};

const DOC = {
  folder: "reports", name: "ui-bugs.md", path: "reports/ui-bugs.md",
  title: "Two UI bugs diagnosed", size: 8000, mtime: "2026-07-25T12:00:00.000Z",
};

const SHELF = { works: [WORK], docs: [DOC] };

/** file: string → served as that file's bytes; object → served as a JSON refusal with a status. */
function stubLibrary(fileBody: string | { status: number; error: string }, shelf: unknown = SHELF) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/library/shelf")) return new Response(JSON.stringify(shelf), { status: 200 });
    if (url.startsWith("/api/library/search")) return new Response(JSON.stringify({ q: "", hits: [] }), { status: 200 });
    if (url.startsWith("/api/library/file")) {
      return typeof fileBody === "string"
        ? new Response(fileBody, { status: 200 })
        : new Response(JSON.stringify({ error: fileBody.error }), { status: fileBody.status });
    }
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  }));
}

async function openHeadline() {
  fireEvent.click(await screen.findByText("final-report.md"));
}

describe("Library — safety (agent output is never markup)", () => {
  // A renderer feeding dangerouslySetInnerHTML would make any agent-written deliverable a
  // script-injection path into the cockpit.
  it("never injects markup — HTML inside a deliverable becomes no element", async () => {
    stubLibrary('# Notes\n\n<img src=x onerror=alert(1)>\n<script>alert(document.cookie)</script>');
    const { container } = render(<Library />);
    await openHeadline();
    await screen.findByText(/Notes/);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  // The server echoes the caller's own path back in its refusals, so the error slot is
  // attacker-influenced text and must be rendered as text.
  it("shows a refusal as text, not as markup", async () => {
    stubLibrary({ status: 404, error: "path escapes the workspace: <img src=x onerror=alert(1)>" });
    const { container } = render(<Library />);
    await openHeadline();
    await screen.findByText(/path escapes the workspace/);
    expect(container.querySelector("img")).toBeNull();
  });

  it("offers an .svg as a download rather than rendering it", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => "blob:stub", revokeObjectURL: () => {},
    }));
    const work = { ...WORK, headline: null, files: [file("diagram.svg")] };
    stubLibrary('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { works: [work], docs: [] });
    const { container } = render(<Library />);
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
    const work = { ...WORK, headline: null, files: [file("deck.pdf", { size: 57 })] };
    stubLibrary("%PDF-1.7 binary payload — cannot be represented as text", { works: [work], docs: [] });
    const { container } = render(<Library />);
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
    const work = { ...WORK, headline: null, files: [file("real.pdf")] };
    stubLibrary("%PDF-1.7\n...body...\ntrailer\n%%EOF\n", { works: [work], docs: [] });
    const { container } = render(<Library />);
    fireEvent.click(await screen.findByText("real.pdf"));
    await waitFor(() => expect(container.querySelector("embed")).toBeTruthy());
  });
});

describe("Library — the shelf", () => {
  it("shows finished work and standalone docs in one month-grouped timeline", async () => {
    stubLibrary("# body");
    render(<Library />);
    // The work card: title, department, its deliverables.
    expect(await screen.findByText("Hotel TV systems report")).toBeTruthy();
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("final-report.md")).toBeTruthy();
    // The doc row: folder tag + the doc's own title, not its slug.
    expect(screen.getByText("reports")).toBeTruthy();
    expect(screen.getByText("Two UI bugs diagnosed")).toBeTruthy();
    // Month groups place work in time; both months exist because the items are a month apart.
    expect(screen.getByText("August 2026")).toBeTruthy();
    expect(screen.getByText("July 2026")).toBeTruthy();
    // The header states what the shelf holds.
    expect(screen.getByText(/1 finished goal · 1 documents/)).toBeTruthy();
  });

  it("leads with the headline — the file the goal existed to produce", async () => {
    stubLibrary("# body");
    render(<Library />);
    const card = (await screen.findByTestId("shelf-work"));
    const chips = within(card).getAllByTestId("shelf-file");
    // Server order is newest-first with angle-1 written earlier; headline must still lead.
    expect(chips[0].textContent).toContain("final-report.md");
  });

  it("folds a long file tail instead of burying the goals beneath it", async () => {
    const many = Array.from({ length: 9 }, (_, i) => file(`part-${i}.md`));
    stubLibrary("# body", { works: [{ ...WORK, headline: null, files: many }], docs: [] });
    render(<Library />);
    await screen.findByTestId("shelf-work");
    expect(screen.getAllByTestId("shelf-file")).toHaveLength(6);
    fireEvent.click(screen.getByText("+3 more"));
    expect(screen.getAllByTestId("shelf-file")).toHaveLength(9);
  });

  it("filters to goals or docs on the segmented control", async () => {
    stubLibrary("# body");
    render(<Library />);
    await screen.findByTestId("shelf-work");
    fireEvent.click(screen.getByText("docs"));
    expect(screen.queryByTestId("shelf-work")).toBeNull();
    expect(screen.getByTestId("shelf-doc")).toBeTruthy();
    fireEvent.click(screen.getByText("goals"));
    expect(screen.getByTestId("shelf-work")).toBeTruthy();
    expect(screen.queryByTestId("shelf-doc")).toBeNull();
  });

  it("links each work to its goal — the how behind the what", async () => {
    stubLibrary("# body");
    render(<Library />);
    const link = (await screen.findByText("how it was made ↗")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/goals/hotel-tv");
  });

  it("a failed goal wears its status; a done one stays quiet", async () => {
    stubLibrary("# body", { works: [WORK, { ...WORK, id: "g2", slug: "b", title: "Broken run", status: "failed" }], docs: [] });
    render(<Library />);
    await screen.findByText("Broken run");
    expect(screen.getByText("failed")).toBeTruthy();
    // "done" appears nowhere: on a shelf of finished work it would be pure noise.
    expect(screen.queryByText("done")).toBeNull();
  });

  it("an empty shelf explains itself", async () => {
    stubLibrary("# body", { works: [], docs: [] });
    render(<Library />);
    expect(await screen.findByText(/Nothing on the shelf yet/)).toBeTruthy();
  });

  // dist deploys the instant it builds, while the daemon serves /api/library/shelf only after
  // a restart — the seam ui2-build-is-a-deploy exists to cover.
  it("a daemon without the endpoint reads as 'restart', never as an empty library", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    render(<Library />);
    expect(await screen.findByText(/restart the daemon/)).toBeTruthy();
    expect(screen.queryByText(/Nothing on the shelf yet/)).toBeNull();
  });
});

describe("Library — search", () => {
  function stubSearch(hits: unknown[]) {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/library/shelf")) return new Response(JSON.stringify(SHELF), { status: 200 });
      if (url.startsWith("/api/library/search")) return new Response(JSON.stringify({ q: "x", hits }), { status: 200 });
      return new Response("# body", { status: 200 });
    }));
  }

  it("labels every hit by where in the record it lives", async () => {
    stubSearch([
      { path: "wiki/topics/Couscous.md", title: "Couscous", snippet: "semolina", score: 9, ts: "2026-08-09T00:00:00.000Z", wiki: true },
      { path: "knowledge/marseille.md", title: "marseille", snippet: "airport", score: 4, ts: "2026-08-01T00:00:00.000Z", wiki: false },
    ]);
    render(<Library />);
    await screen.findByTestId("shelf-work");
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "semolina" } });
    await waitFor(() => expect(screen.getByText(/2 results for/)).toBeTruthy());
    expect(screen.getByText("wiki")).toBeTruthy();
    expect(screen.getByText("knowledge")).toBeTruthy();
  });

  it("a hit opens straight into the reader — no tabs to land in first", async () => {
    stubSearch([
      { path: "knowledge/marseille.md", title: "marseille", snippet: "airport", score: 4, ts: "2026-08-01T00:00:00.000Z", wiki: false },
    ]);
    render(<Library />);
    await screen.findByTestId("shelf-work");
    fireEvent.change(screen.getByLabelText("Search everything"), { target: { value: "airport" } });
    await waitFor(() => expect(screen.getByText(/1 result for/)).toBeTruthy());
    fireEvent.click(screen.getByText("marseille"));
    await waitFor(() => expect(screen.getByTestId("reader")).toBeTruthy());
  });

  it("an empty result set says what to do next, and clearing returns to the shelf", async () => {
    stubSearch([]);
    render(<Library />);
    const box = await screen.findByLabelText("Search everything");
    fireEvent.change(box, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText(/Nothing matched/)).toBeTruthy());
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() => expect(screen.getByTestId("shelf-work")).toBeTruthy());
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
    stubApi({ "/api/state": STATE_STUB, "/api/attention": [], "/api/library/shelf": SHELF });
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
      "/api/library/shelf": SHELF,
    });
    render(<App />);
    const heading = await screen.findByText("Library"); // the h1, not the lowercase tab label
    expect(heading.closest("div.hidden"), "the library section renders hidden on its own route").toBeNull();
  });
});
