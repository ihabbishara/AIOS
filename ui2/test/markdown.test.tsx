// ui2/test/markdown.test.tsx — the chat markdown-lite renderer: safe subset, literal fallback.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Markdown } from "../src/lib/markdown.js";

afterEach(cleanup);

describe("Markdown (chat bubbles)", () => {
  it("renders bold, inline code, and links from a mixed line", () => {
    render(<Markdown text="Run **9 specialists** via `plan_goal` — see [docs](https://example.com/x)" />);
    expect(screen.getByText("9 specialists").tagName).toBe("STRONG");
    expect(screen.getByText("plan_goal").tagName).toBe("CODE");
    const a = screen.getByText("docs") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.href).toBe("https://example.com/x");
    expect(a.rel).toContain("noreferrer");
  });

  it("groups numbered lines into an ordered list", () => {
    render(<Markdown text={"1. analyst\n2. researcher\n3. architect"} />);
    const ol = screen.getByRole("list");
    expect(ol.tagName).toBe("OL");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("renders fenced code verbatim — no inline parsing inside", () => {
    render(<Markdown text={"before\n```\nconst a = **not bold**;\n```"} />);
    expect(screen.getByText(/\*\*not bold\*\*/).closest("pre")).toBeTruthy();
  });

  it("never injects markup — HTML in text stays literal", () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("only links http(s) — javascript: URLs stay literal text", () => {
    const { container } = render(<Markdown text="[click](javascript:alert(1))" />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("parses inline syntax INSIDE bold, not just around it", () => {
    // Bold used to push its inner text as a raw string, so anything nested went literal.
    render(<Markdown text="**see [docs](https://example.com) and `code`**" />);
    const a = screen.getByText("docs") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.closest("strong")).toBeTruthy();
    expect(screen.getByText("code").tagName).toBe("CODE");
  });
});

describe("Markdown (wiki pages)", () => {
  it("makes [[Page]] a button only when a handler is given", () => {
    const { unmount } = render(<Markdown text="grown in [[Algeria]]" />);
    // Chat has no handler, so a wikilink must stay literal — unchanged behaviour.
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/\[\[Algeria\]\]/)).toBeTruthy();
    unmount();

    const seen: string[] = [];
    render(<Markdown text="grown in [[Algeria]]" onWikiLink={(p) => seen.push(p)} />);
    const b = screen.getByRole("button", { name: "Algeria" });
    b.click();
    expect(seen).toEqual(["Algeria"]);
  });

  it("resolves a [[wikilink]] nested inside bold", () => {
    // 136 links across 66 of the live wiki's 202 pages sit inside **bold**; before the bold
    // branch recursed, every one of them rendered as dead literal text.
    render(<Markdown text="**They connect through [[Marseille Saint-Charles Station]].**" onWikiLink={() => {}} />);
    const b = screen.getByRole("button", { name: "Marseille Saint-Charles Station" });
    expect(b.closest("strong")).toBeTruthy();
  });

  it("renders [[Page|alias]] as the alias and leaves [[#anchor]] literal", () => {
    render(<Markdown text="[[Algeria|the country]] then [[#Resolution]]" onWikiLink={() => {}} />);
    expect(screen.getByRole("button", { name: "the country" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "#Resolution" })).toBeNull();
    expect(screen.getByText(/\[\[#Resolution\]\]/)).toBeTruthy();
  });

  it("a wikilink is a button, never an anchor — navigation stays in-app", () => {
    const { container } = render(<Markdown text="[[Algeria]]" onWikiLink={() => {}} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("follows a page-relative record link only when a handler is given", () => {
    const { unmount } = render(<Markdown text="see [record](../../knowledge/x.md)" />);
    // Chat has no handler: the schema's record link stays literal, as before.
    expect(screen.queryByRole("button")).toBeNull();
    unmount();

    const seen: string[] = [];
    render(<Markdown text="see [record](../../knowledge/x.md)" onRelLink={(h) => seen.push(h)} />);
    screen.getByRole("button", { name: "record" }).click();
    expect(seen).toEqual(["../../knowledge/x.md"]);
  });

  it("only ./ and ../ hrefs are relative links — an absolute path stays literal", () => {
    const { container } = render(<Markdown text="[x](/etc/passwd) and [y](file.md)" onRelLink={() => {}} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("Markdown softWrap (vault prose is hard-wrapped)", () => {
  it("pairs a **bold** span split across a soft wrap", () => {
    const text = "a terminal REPL with **no public\nports** (outbound-only).";
    // Without softWrap the two halves never pair and the asterisks show through.
    const { container: plain } = render(<Markdown text={text} />);
    expect(plain.textContent).toContain("**no public");
    cleanup();

    render(<Markdown text={text} softWrap />);
    expect(screen.getByText("no public ports").tagName).toBe("STRONG");
  });

  it("keeps a wrapped list item as ONE item", () => {
    render(<Markdown text={"- first line of the point\n  continues here\n- second point"} softWrap />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("first line of the point continues here");
  });

  it("a blank line still separates paragraphs, and headings still break", () => {
    render(<Markdown text={"one\ntwo\n\nthree\n# H\nfour"} softWrap />);
    expect(screen.getByText("one two")).toBeTruthy();
    expect(screen.getByText("three")).toBeTruthy();
    expect(screen.getByText("H")).toBeTruthy();
    expect(screen.getByText("four")).toBeTruthy();
  });

  it("never joins inside a fence — code stays verbatim", () => {
    render(<Markdown text={"before\n```\nconst a = 1;\nconst b = 2;\n```"} softWrap />);
    const pre = screen.getByText(/const a = 1;/).closest("pre")!;
    expect(pre.textContent).toBe("const a = 1;\nconst b = 2;");
  });

  it("chat does NOT join — an authored line break stays a line break", () => {
    // Standup output is three deliberate lines; joining them would be the regression.
    const { container } = render(<Markdown text={"done: X\ntoday: Y\nblockers: none"} />);
    expect(container.textContent).toContain("done: X");
    expect(screen.getByText("today: Y")).toBeTruthy();
    expect(screen.queryByText("done: X today: Y blockers: none")).toBeNull();
  });
});
