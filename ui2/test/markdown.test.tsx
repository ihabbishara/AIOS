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
    render(<Markdown text={"1. halalo\n2. researcher\n3. architect"} />);
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
});
