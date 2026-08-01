// ui2/test/library-render.test.tsx — the read-only workspace browser. Every file it shows was
// written by an agent from model output, so "renders as text, never as markup" is the rule the
// whole view is built around and the thing these tests exist to pin.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Library } from "../src/views/Library.js";
import { App } from "../src/App.js";
import { BottomTabs } from "../src/components/BottomTabs.js";
import { SECTIONS } from "../src/lib/router.js";
import { stubApi, STATE_STUB } from "./stubs.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });

const TREE = [
  {
    name: "goals", path: "goals", dir: true, size: 0,
    children: [{ name: "report.md", path: "goals/report.md", dir: false, size: 12 }],
  },
  { name: "diagram.svg", path: "diagram.svg", dir: false, size: 40 },
];

/** file: string → served as that file's bytes; object → served as a JSON refusal with a status. */
function stubLibrary(file: string | { status: number; error: string }) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/library/tree")) return new Response(JSON.stringify({ nodes: TREE }), { status: 200 });
    if (url.startsWith("/api/library/file")) {
      return typeof file === "string"
        ? new Response(file, { status: 200 })
        : new Response(JSON.stringify({ error: file.error }), { status: file.status });
    }
    return new Response(JSON.stringify({ error: `no stub for ${url}` }), { status: 404 });
  }));
}

describe("Library view", () => {
  it("lists the tree and opens a file as preformatted text", async () => {
    stubLibrary("# Chaser\n\nbody");
    render(<Library />);
    fireEvent.click(await screen.findByText("report.md"));
    const pre = await screen.findByText(/# Chaser/);
    expect(pre.tagName).toBe("PRE");
  });

  // Markdown is deliberately NOT parsed: a renderer feeding dangerouslySetInnerHTML would make
  // any agent-written note a script-injection path into the cockpit.
  it("never injects markup — HTML inside a workspace file stays literal", async () => {
    stubLibrary('# Notes\n\n<img src=x onerror=alert(1)>\n<script>alert(document.cookie)</script>');
    const { container } = render(<Library />);
    fireEvent.click(await screen.findByText("report.md"));
    await screen.findByText(/# Notes/);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  // The server echoes the caller's own path back in its refusals, so the error slot is attacker-
  // influenced text and must be rendered as text.
  it("shows a refusal as text, not as markup", async () => {
    stubLibrary({ status: 404, error: "path escapes the workspace: <img src=x onerror=alert(1)>" });
    const { container } = render(<Library />);
    fireEvent.click(await screen.findByText("report.md"));
    await screen.findByText(/path escapes the workspace/);
    expect(container.querySelector("img")).toBeNull();
    // The server's message, not a bare "HTTP 404" — a JSON refusal must never reach the reader
    // as though it were the file's content either.
    expect(container.querySelector("pre")).toBeNull();
  });

  it("offers an .svg as a download rather than rendering it", async () => {
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: () => "blob:stub", revokeObjectURL: () => {},
    }));
    stubLibrary('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const { container } = render(<Library />);
    fireEvent.click(await screen.findByText("diagram.svg"));
    const link = (await screen.findByText("Download")) as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("download")).toBe("diagram.svg");
    // Not an <img>/<embed>: SVG in either would execute in the cockpit's origin.
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(container.querySelector("embed")).toBeNull();
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
    stubApi({ "/api/state": STATE_STUB, "/api/attention": [], "/api/library/tree": { nodes: [] } });
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
      "/api/library/tree": { nodes: [] },
    });
    render(<App />);
    const heading = await screen.findByText("Library"); // the h1, not the lowercase tab label
    expect(heading.closest("div.hidden"), "the library section renders hidden on its own route").toBeNull();
  });
});
