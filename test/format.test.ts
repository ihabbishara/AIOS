import { describe, it, expect } from "vitest";
import { mdToTelegramHtml, mdToSlackMrkdwn } from "../src/channels/format.js";

const SAMPLE = `## Update

**Big additions:**
- **Scheduled agents** — cron-based automation
- See [docs](https://example.com/x) for more

Use \`npm run dev\` to start.

\`\`\`bash
npm test
\`\`\`
`;

describe("mdToTelegramHtml", () => {
  it("converts the common markdown constructs", () => {
    const out = mdToTelegramHtml(SAMPLE);
    expect(out).toContain("<b>Update</b>");
    expect(out).toContain("<b>Big additions:</b>");
    expect(out).toContain("• <b>Scheduled agents</b>");
    expect(out).toContain('<a href="https://example.com/x">docs</a>');
    expect(out).toContain("<code>npm run dev</code>");
    expect(out).toContain("<pre>npm test</pre>");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^##/m);
  });

  it("escapes raw HTML in content", () => {
    expect(mdToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("converts _italic_", () => {
    expect(mdToTelegramHtml("this is _important_ here")).toContain("<i>important</i>");
  });

  it("leaves snake_case alone", () => {
    expect(mdToTelegramHtml("use snake_case_names here")).toBe("use snake_case_names here");
  });
});

describe("mdToSlackMrkdwn", () => {
  it("converts the common markdown constructs", () => {
    const out = mdToSlackMrkdwn(SAMPLE);
    expect(out).toContain("*Update*");
    expect(out).toContain("*Big additions:*");
    expect(out).toContain("• *Scheduled agents*");
    expect(out).toContain("<https://example.com/x|docs>");
    expect(out).toContain("`npm run dev`");
    expect(out).toContain("```npm test```");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^##/m);
  });

  it("does not touch code block contents", () => {
    const out = mdToSlackMrkdwn("```\n**not bold** - not a bullet\n```");
    expect(out).toContain("**not bold** - not a bullet");
  });
});
