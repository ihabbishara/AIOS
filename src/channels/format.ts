/**
 * Converts the agents' markdown replies into each chat platform's native
 * formatting so messages render rich instead of showing raw ** and ##.
 */

/** Telegram HTML parse mode: <b>, <i>, <code>, <pre>, <a>. */
export function mdToTelegramHtml(md: string): string {
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
