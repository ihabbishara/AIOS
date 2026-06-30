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
 * Two datasets, two trade-offs (you can't have both at once without the paid
 * Bot Management add-on):
 *   - httpRequests1dGroups  → daily `uniques`, BOT-FILTERED, but whole-zone only
 *     (no country/device slice). The headline visitor number.
 *   - httpRequestsAdaptiveGroups → sliceable by country + device (UK-mobile), but
 *     BOT-INCLUSIVE (the human-vs-bot score field needs Enterprise Bot Management)
 *     and capped at a 1-DAY query range on this plan, so we loop per day.
 *
 * Read-only: only ever POSTs `viewer { zones { ... } }` reads. Token scope is
 * Analytics:Read on the single zone (least privilege) — covers both datasets.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/** Adaptive queries are capped at a 1-day range on this plan; cap the per-day fan-out. */
const ADAPTIVE_MAX_DAYS = 31;

/** One day of edge traffic for the zone (bot-filtered uniques). */
export interface DailyStat {
  /** ISO date, "YYYY-MM-DD". */
  date: string;
  /** Cloudflare edge unique visitors — bot-filtered, includes cache hits. */
  uniques: number;
  pageViews: number;
  requests: number;
}

/** GB traffic by device, summed over the window. NOTE: bot-inclusive (adaptive dataset). */
export interface UkDevice {
  device: string;
  requests: number;
  visits: number;
}

export interface UkBreakdown {
  /** Days actually covered by the adaptive fan-out (≤ requested, ≤ ADAPTIVE_MAX_DAYS). */
  days: number;
  /** True when the adaptive window was capped below the requested range. */
  truncated: boolean;
  byDevice: UkDevice[];
  totalVisits: number;
  mobileVisits: number;
  mobileRequests: number;
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
   * GB + device breakdown from the adaptive dataset. Best-effort: undefined when
   * the adaptive call fails. BOT-INCLUSIVE — these counts contain automated
   * traffic; the bot-excluded figure is the whole-zone `totalUniques` above.
   */
  uk?: UkBreakdown;
}

/** "YYYY-MM-DD" for a Date, in UTC (Cloudflare 1d groups are UTC-dated). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The N UTC dates ending at `until` (inclusive), oldest first. */
export function dateWindow(until: string, days: number): string[] {
  const end = new Date(`${until}T00:00:00Z`).getTime();
  return Array.from({ length: days }, (_, i) =>
    isoDate(new Date(end - (days - 1 - i) * 86_400_000)),
  );
}

/** The daily-rollup query: bot-filtered uniques, solid on every plan. */
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

/** GB traffic grouped by device for a single day. datetime range MUST be ≤ 1 day. */
export function buildUkDeviceQuery(): string {
  return `query UkDevices($zoneTag: String!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        limit: 50
        filter: { datetime_geq: $start, datetime_leq: $end, clientCountryName: "GB" }
      ) {
        count
        sum { visits }
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

/** One adaptive day's rows → {device, requests, visits}[]. Throws on a GraphQL error body. */
export function parseAdaptiveRows(json: unknown): UkDevice[] {
  const body = json as {
    errors?: Array<{ message: string }>;
    data?: { viewer?: { zones?: Array<{ httpRequestsAdaptiveGroups?: Array<{
      count: number; sum?: { visits?: number }; dimensions: { clientDeviceType: string };
    }> }> } };
  };
  if (body.errors?.length) {
    throw new Error(`Cloudflare GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  const groups = body.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
  return groups.map((g) => ({
    device: (g.dimensions.clientDeviceType || "unknown").toLowerCase(),
    requests: g.count ?? 0,
    visits: g.sum?.visits ?? 0,
  }));
}

/** Fold per-day device rows into one GB breakdown. */
export function aggregateUk(perDay: UkDevice[][], days: number, truncated: boolean): UkBreakdown {
  const byDeviceMap = new Map<string, UkDevice>();
  for (const day of perDay) {
    for (const row of day) {
      const cur = byDeviceMap.get(row.device) ?? { device: row.device, requests: 0, visits: 0 };
      cur.requests += row.requests;
      cur.visits += row.visits;
      byDeviceMap.set(row.device, cur);
    }
  }
  const byDevice = [...byDeviceMap.values()].sort((a, b) => b.requests - a.requests);
  const mobile = byDeviceMap.get("mobile") ?? { device: "mobile", requests: 0, visits: 0 };
  return {
    days,
    truncated,
    byDevice,
    totalVisits: byDevice.reduce((a, d) => a + d.visits, 0),
    mobileVisits: mobile.visits,
    mobileRequests: mobile.requests,
  };
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

/** GB-by-device over the last `days` (capped at ADAPTIVE_MAX_DAYS), one call per day. */
export async function fetchUkBreakdown(opts: {
  token: string;
  zoneId: string;
  until: string;
  days: number;
}): Promise<UkBreakdown> {
  const truncated = opts.days > ADAPTIVE_MAX_DAYS;
  const want = Math.min(opts.days, ADAPTIVE_MAX_DAYS);
  const dates = dateWindow(opts.until, want);
  const perDay = await Promise.all(
    dates.map((d) =>
      gql(opts.token, buildUkDeviceQuery(), {
        zoneTag: opts.zoneId,
        start: `${d}T00:00:00Z`,
        end: `${d}T23:59:59Z`,
      }).then(parseAdaptiveRows),
    ),
  );
  return aggregateUk(perDay, want, truncated);
}

/**
 * Fetch edge visitor stats for the last `days` days (default 7). The GB/device
 * breakdown is best-effort: a failure there degrades to uk:undefined rather than
 * failing the whole call (the bot-filtered totals always stand).
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
    stats.uk = await fetchUkBreakdown({ token: opts.token, zoneId: opts.zoneId, until, days });
  } catch {
    // Adaptive dataset hiccup (rate-limit, transient) — totals above still stand.
    stats.uk = undefined;
  }
  return stats;
}
