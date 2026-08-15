import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchVisitorStats, type VisitorStats } from "./analytics.js";

/** Server + tool names → tool id is `mcp__cloudflare_analytics__cloudflare_analytics`. */
export const CLOUDFLARE_TOOL = "mcp__cloudflare_analytics__cloudflare_analytics";

/** Which zone this is, for the tool description and setup message. The zone itself is identified
 *  by CLOUDFLARE_ZONE_ID; this is only the human name, and naming it is the operator's business. */
const siteName = (): string => process.env.CLOUDFLARE_SITE ?? "the configured zone";

const n = (x: number): string => x.toLocaleString();
const pct = (num: number, den: number): string => (den > 0 ? `${((num / den) * 100).toFixed(0)}%` : "n/a");

/** Phone-readable, HONESTLY-LABELED rendering. Never conflated with log counts. */
function render(s: VisitorStats): string {
  const lines = [
    `Cloudflare edge analytics — zone ${s.zoneId}, ${s.since}…${s.until} (${s.days.length}d)`,
    `Counted at the CDN edge (includes cached hits the origin never logs).`,
    ``,
    `— Bot-filtered totals (whole zone) —`,
    `Unique visitors: ${n(s.totalUniques)}`,
    `Page views:      ${n(s.totalPageViews)}`,
    `Requests:        ${n(s.totalRequests)}`,
  ];

  if (s.uk) {
    const u = s.uk;
    lines.push(
      ``,
      `— UK traffic, by device (${u.days}d${u.truncated ? ", capped" : ""}) —`,
      `These are BOT-INCLUSIVE (the human/bot filter needs Cloudflare Bot Management, not on this plan).`,
      `GB total visits: ${n(u.totalVisits)}`,
      `GB mobile:       ${n(u.mobileVisits)} visits / ${n(u.mobileRequests)} requests` +
        ` (${pct(u.mobileVisits, u.totalVisits)} of GB visits)`,
      ...u.byDevice.map((d) => `  ${d.device}: ${n(d.visits)} visits / ${n(d.requests)} requests`),
    );
  } else {
    lines.push(``, `UK/device breakdown: unavailable this call (adaptive dataset error).`);
  }

  lines.push(
    ``,
    `NOTE: two different "visitor" metrics — bot-FILTERED uniques (whole-zone only) vs bot-INCLUSIVE UK/device visits. Do not add them or call either a log figure; log-derived counts are CDN-undercounted proxies.`,
  );
  return lines.join("\n");
}

/**
 * In-process MCP server exposing one read-only tool: `cloudflare_analytics`.
 * Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID from env. Fail-closed and
 * honest when unconfigured — returns setup instructions, not a fake number.
 */
export function buildCloudflareServer() {
  const analytics = tool(
    "cloudflare_analytics",
    `Read TRUE visitor traffic for ${siteName()} from Cloudflare's edge analytics (read-only). ` +
      "Use this as the source of truth for visitor/traffic numbers — NOT origin access logs, which " +
      "undercount because Cloudflare's CDN serves cached hits the origin never logs. Returns whole-zone " +
      "unique visitors (BOT-FILTERED), page views, requests, plus a UK-by-device breakdown (mobile/desktop/" +
      "tablet visits) which is BOT-INCLUSIVE — good for TikTok/campaign mobile-UK trends, but not a " +
      "bot-excluded headcount (that needs Cloudflare Bot Management).",
    {
      days: z
        .number()
        .int()
        .min(1)
        .max(366)
        .optional()
        .describe("How many days back to report, ending today. Default 7."),
    },
    async (args): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      const token = process.env.CLOUDFLARE_API_TOKEN;
      const zoneId = process.env.CLOUDFLARE_ZONE_ID;
      if (!token || !zoneId) {
        return {
          content: [{
            type: "text",
            text:
              "Cloudflare analytics not configured. The operator must set CLOUDFLARE_API_TOKEN " +
              `(scope Analytics:Read, zone ${siteName()}) and CLOUDFLARE_ZONE_ID in the daemon env (.env), ` +
              "then restart. Until then, true edge traffic is unavailable — do not substitute log-derived " +
              "counts and call them traffic; label any log figure as a CDN-undercounted proxy.",
          }],
        };
      }
      try {
        const stats = await fetchVisitorStats({ token, zoneId, days: args.days });
        return { content: [{ type: "text", text: render(stats) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Cloudflare analytics failed: ${(err as Error).message}` }] };
      }
    },
  );

  return createSdkMcpServer({
    name: "cloudflare_analytics",
    version: "0.1.0",
    tools: [analytics],
  });
}
