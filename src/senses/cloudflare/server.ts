import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchVisitorStats, type VisitorStats } from "./analytics.js";

/** Server + tool names → tool id is `mcp__halalo_analytics__cloudflare_analytics`. */
export const CLOUDFLARE_TOOL = "mcp__halalo_analytics__cloudflare_analytics";

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;

/** Phone-readable, HONESTLY-LABELED rendering. Never conflated with log counts. */
function render(s: VisitorStats): string {
  const lines = [
    `Cloudflare edge analytics — zone ${s.zoneId}, ${s.since}…${s.until} (${s.days.length}d)`,
    `Source of truth: counted at the CDN edge, so it includes cached hits the origin never logs; uniques are bot-filtered by Cloudflare.`,
    ``,
    `Total unique visitors: ${s.totalUniques.toLocaleString()}`,
    `Total page views:      ${s.totalPageViews.toLocaleString()}`,
    `Total requests:        ${s.totalRequests.toLocaleString()}`,
    s.mobileShare !== undefined
      ? `Mobile share: ~${pct(s.mobileShare)} of requests (sampled — approximate)`
      : `Mobile/desktop split: unavailable (sampled dataset gated on this plan).`,
    ``,
    `Per day (uniques / pageviews):`,
    ...s.days.map((d) => `  ${d.date}: ${d.uniques.toLocaleString()} / ${d.pageViews.toLocaleString()}`),
    ``,
    `NOTE: these are TRUE visitor counts. Any log-derived "visitors" figure is a CDN-undercounted proxy — present them as different metrics, never interchangeably.`,
  ];
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
    "Read TRUE visitor traffic for halalo.co.uk from Cloudflare's edge analytics (read-only). " +
      "Use this as the source of truth for visitor/traffic numbers — NOT origin access logs, which " +
      "undercount because Cloudflare's CDN serves cached hits the origin never logs. Returns daily " +
      "unique visitors (bot-filtered), page views, requests, and a best-effort mobile share.",
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
              "(scope Analytics:Read, zone halalo.co.uk) and CLOUDFLARE_ZONE_ID in the daemon env (.env), " +
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
    name: "halalo_analytics",
    version: "0.1.0",
    tools: [analytics],
  });
}
