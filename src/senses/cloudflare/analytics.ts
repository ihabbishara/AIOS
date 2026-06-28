/**
 * Cloudflare GraphQL Analytics client (read-only).
 *
 * Why this exists: the Halalo "visitors" number was derived from origin access
 * logs, but the site sits behind Cloudflare's CDN — the edge serves cached hits
 * the origin never logs, so log-derived counts structurally UNDERCOUNT real
 * traffic. Cloudflare's edge `uniques` is the source of truth: it counts at the
 * CDN and is already bot-filtered by CF's visitor heuristic, which maps cleanly
 * onto "non-bot visitors".
 *
 * Read-only: this only ever POSTs GraphQL `viewer { zones { ... } }` reads. The
 * token must be scoped Analytics:Read on the single zone (least privilege).
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** One day of edge traffic for the zone. */
export interface DailyStat {
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  /** Cloudflare edge unique visitors — bot-filtered, includes cache hits. */
  uniques: number;
  pageViews: number;
  requests: number;
}

export interface VisitorStats {
  zoneId: string;
  since: string;
  until: string;
  days: DailyStat[];
  totalUniques: number;
  totalPageViews: number;
  totalRequests: number;
  /**
   * Mobile share of sampled requests (0–1), from the adaptive dataset. Sampled
   * and best-effort — undefined when the device breakdown is unavailable
   * (plan/permission/empty). Never treat as exact.
   */
  mobileShare?: number;
}

/** "YYYY-MM-DD" for a Date, in UTC (Cloudflare 1d groups are UTC-dated). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The daily-rollup query: solid on every plan. zoneTag/since/until are bound as vars. */
export function buildDailyQuery(): string {
  return `query Visitors($zoneTag: String!, $since: String!, $until: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(
        limit: 366
        filter: { date_geq: $since, date_leq: $until }
        orderBy: [date_ASC]
      ) {
        dimensions { date }
        uniq { uniques }
        sum { pageViews requests }
      }
    }
  }
}`;
}

/** Best-effort device split (sampled adaptive dataset) — mobile fraction only. */
export function buildDeviceQuery(): string {
  return `query Devices($zoneTag: String!, $sinceTs: Time!, $untilTs: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        limit: 20
        filter: { datetime_geq: $sinceTs, datetime_leq: $untilTs }
      ) {
        count
        dimensions { clientDeviceType }
      }
    }
  }
}`;
}

/** Parse the daily-rollup response into typed stats. Throws on a GraphQL error body. */
export function parseDaily(json: unknown, zoneId: string, since: string, until: string): VisitorStats {
  const body = json as {
    errors?: Array<{ message: string }>;
    data?: { viewer?: { zones?: Array<{ httpRequests1dGroups?: Array<{
      dimensions: { date: string };
      uniq: { uniques: number };
      sum: { pageViews: number; requests: number };
    }> }> } };
  };
  if (body.errors?.length) {
    throw new Error(`Cloudflare GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const groups = body.data?.viewer?.zones?.[0]?.httpRequests1dGroups ?? [];
  const days: DailyStat[] = groups.map((g) => ({
    date: g.dimensions.date,
    uniques: g.uniq?.uniques ?? 0,
    pageViews: g.sum?.pageViews ?? 0,
    requests: g.sum?.requests ?? 0,
  }));
  return {
    zoneId,
    since,
    until,
    days,
    totalUniques: days.reduce((a, d) => a + d.uniques, 0),
    totalPageViews: days.reduce((a, d) => a + d.pageViews, 0),
    totalRequests: days.reduce((a, d) => a + d.requests, 0),
  };
}

/** Pull the mobile fraction (0–1) out of the device-split response, or undefined. */
export function parseMobileShare(json: unknown): number | undefined {
  const groups = (json as { data?: { viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: Array<{
    count: number; dimensions: { clientDeviceType: string };
  }> }> } } }).data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
  if (!groups?.length) return undefined;
  const total = groups.reduce((a, g) => a + (g.count ?? 0), 0);
  if (total <= 0) return undefined;
  const mobile = groups
    .filter((g) => g.dimensions.clientDeviceType?.toLowerCase() === "mobile")
    .reduce((a, g) => a + (g.count ?? 0), 0);
  return mobile / total;
}

async function gql(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    // 403 = token scope/zone mismatch, 401 = bad token. Surface status, not body (may echo token context).
    throw new Error(`Cloudflare API HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetch edge visitor stats for the last `days` days (default 7). The device
 * split is best-effort: a failure there degrades to mobileShare:undefined
 * rather than failing the whole call.
 */
export async function fetchVisitorStats(opts: {
  token: string;
  zoneId: string;
  days?: number;
  now?: Date; // injectable for tests; defaults to current time
}): Promise<VisitorStats> {
  const days = Math.max(1, Math.min(366, opts.days ?? 7));
  const now = opts.now ?? new Date();
  const until = isoDate(now);
  const since = isoDate(new Date(now.getTime() - (days - 1) * 86_400_000));

  const dailyJson = await gql(opts.token, buildDailyQuery(), {
    zoneTag: opts.zoneId,
    since,
    until,
  });
  const stats = parseDaily(dailyJson, opts.zoneId, since, until);

  try {
    const deviceJson = await gql(opts.token, buildDeviceQuery(), {
      zoneTag: opts.zoneId,
      sinceTs: `${since}T00:00:00Z`,
      untilTs: `${until}T23:59:59Z`,
    });
    stats.mobileShare = parseMobileShare(deviceJson);
  } catch {
    // Sampled adaptive dataset is plan/permission-gated; totals above still stand.
    stats.mobileShare = undefined;
  }
  return stats;
}
