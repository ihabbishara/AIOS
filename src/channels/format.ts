/**
 * Converts the agents' markdown replies into each chat platform's native
 * formatting so messages render rich instead of showing raw ** and ##.
 */

/**
 * Markdown tables don't exist on Telegram and render as walls of pipes on phones.
 * Convert each table to compact lines: header becomes a bold caption, every row a bullet.
 */
export function convertTables(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isRow = (l: string | undefined) => !!l && /^\s*\|.*\|\s*$/.test(l);
    if (isRow(lines[i]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(lines[i]);
      i += 2; // skip header + separator
      out.push(`**${header.join(" · ")}**`);
      while (isRow(lines[i])) {
        out.push(`- ${cells(lines[i]).filter(Boolean).join(" · ")}`);
        i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/** Telegram HTML parse mode: <b>, <i>, <code>, <pre>, <a>. */
export function mdToTelegramHtml(md: string): string {
  md = convertTables(md);
  // Escape HTML first — everything below inserts tags deliberately.
  let s = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Fenced code blocks (before inline rules touch their contents)
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.replace(/\n$/, "")}</pre>`);
  // Inline code
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // Bold **text** / __text__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  // Italic _text_ (single * is too ambiguous with bullets — skipped)
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/gm, "$1<i>$2</i>");
  // Headings -> bold line
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  // Bullets -> •
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  // Horizontal rules -> blank
  s = s.replace(/^[-*_]{3,}\s*$/gm, "");
  return s;
}

/** Slack mrkdwn: *bold*, _italic_, `code`, ```pre```, <url|text>. */
export function mdToSlackMrkdwn(md: string): string {
  md = convertTables(md);
  const blocks: string[] = [];
  // Protect fenced code blocks (Slack renders ``` natively; inline rules must not touch them)
  let s = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push("```" + code.replace(/\n$/, "") + "```");
    return `\x07CB${blocks.length - 1}\x07`;
  });

  // Links [text](url) -> <url|text>
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
  // Bold ** -> * (Slack bold is single *)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  s = s.replace(/__([^_\n]+)__/g, "*$1*");
  // Headings -> bold line
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  // Bullets -> •
  s = s.replace(/^(\s*)-\s+/gm, "$1• ");
  // Horizontal rules -> blank
  s = s.replace(/^[-*_]{3,}\s*$/gm, "");

  // Restore code blocks
  s = s.replace(/\x07CB(\d+)\x07/g, (_m, i: string) => blocks[Number(i)]);
  return s;
}
