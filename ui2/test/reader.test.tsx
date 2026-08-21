// ui2/test/reader.test.tsx — the artifact reading view: rendered markdown (not a <pre> dump),
// adjustable measure/size persisted, esc to close, mono fallback for non-markdown files.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Reader } from "../src/components/Reader.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const MD = "# Findings\n\nSome **bold** text.\n\n- first\n- second\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";

describe("Reader", () => {
  it("renders markdown as a document: headings, emphasis, lists, gfm tables", () => {
    render(<Reader file="report.md" content={MD} onClose={() => {}} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Findings");
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("table")).toBeTruthy(); // remark-gfm
    expect(document.querySelector(".reader-prose")).toBeTruthy();
  });

  it("falls back to mono text for a non-markdown file", () => {
    render(<Reader file="data.json" content='{"a":1}' onClose={() => {}} />);
    expect(document.querySelector(".reader-prose")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toBe('{"a":1}');
  });

  it("escape and the close button both close; backdrop click closes, content click does not", () => {
    let closed = 0;
    const { rerender } = render(<Reader file="r.md" content={MD} onClose={() => closed++} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);
    rerender(<Reader file="r.md" content={MD} onClose={() => closed++} />);
    fireEvent.click(screen.getByLabelText("Close reader"));
    expect(closed).toBe(2);
    fireEvent.click(screen.getByRole("heading", { level: 1 })); // content: no close
    expect(closed).toBe(2);
    fireEvent.click(screen.getByTestId("reader")); // backdrop
    expect(closed).toBe(3);
  });

  it("width and size controls persist across mounts", () => {
    const { unmount } = render(<Reader file="r.md" content={MD} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Reading width")); // wide -> full
    fireEvent.click(screen.getByLabelText("Larger text"));
    unmount();
    render(<Reader file="r.md" content={MD} onClose={() => {}} />);
    expect(screen.getByLabelText("Reading width").textContent).toBe("full");
    const col = document.querySelector(".max-w-none");
    expect(col).toBeTruthy();
    expect(col!.className).toContain("text-[16px]");
  });

  it("shows the on-disk path when given one", () => {
    render(<Reader file="r.md" content={MD} path="/vault/goals/g1/r.md" onClose={() => {}} />);
    expect(screen.getByTitle("/vault/goals/g1/r.md")).toBeTruthy();
  });

  it("frontmatter never becomes a heading — it folds into a collapsed metadata strip", () => {
    const doc = `---\ncreated: "2026-08-19"\nrole: "clio"\nobjections: "A very long critic paragraph."\n---\n\nDone. The deliverable is written.\n\n## What happened\n`;
    render(<Reader file="report.md" content={doc} onClose={() => {}} />);
    // the ONLY h2 is the document's own — the shipped bug rendered the whole block as one
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual(["What happened"]);
    expect(screen.queryByText(/A very long critic paragraph/)).toBeNull(); // collapsed
    fireEvent.click(screen.getByText(/document metadata · 3 fields/));
    expect(screen.getByText("A very long critic paragraph.")).toBeTruthy();
    expect(screen.getByText("clio")).toBeTruthy();
  });
});
