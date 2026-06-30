import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isoDate,
  dateWindow,
  parseDaily,
  parseAdaptiveRows,
  aggregateUk,
  fetchUkBreakdown,
  fetchVisitorStats,
} from "../src/senses/cloudflare/analytics.js";

const dailyBody = {
  data: { viewer: { zones: [{ httpRequests1dGroups: [
    { dimensions: { date: "2026-06-26" }, uniq: { uniques: 100 }, sum: { pageViews: 400, requests: 900 } },
    { dimensions: { date: "2026-06-27" }, uniq: { uniques: 150 }, sum: { pageViews: 600, requests: 1200 } },
  ] }] } },
};

const ukDayBody = {
  data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
    { count: 1000, sum: { visits: 50 }, dimensions: { clientDeviceType: "mobile" } },
    { count: 4000, sum: { visits: 120 }, dimensions: { clientDeviceType: "desktop" } },
  ] }] } },
};

const emptyUk = { data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } };
const jsonRes = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body });

describe("parseDaily", () => {
  it("maps days and sums totals", () => {
    const s = parseDaily(dailyBody, "zone1", "2026-06-26", "2026-06-27");
    expect(s.totalUniques).toBe(250);
    expect(s.totalPageViews).toBe(1000);
    expect(s.totalRequests).toBe(2100);
    expect(s.days[0]).toMatchObject({ date: "2026-06-26", uniques: 100 });
  });

  it("throws on a GraphQL error body (so a bad token never looks like zero traffic)", () => {
    expect(() => parseDaily({ errors: [{ message: "Authentication error" }] }, "z", "a", "b")).toThrow(/Authentication/);
  });

  it("treats an empty zone list as zero, not a crash", () => {
    const s = parseDaily({ data: { viewer: { zones: [] } } }, "z", "a", "b");
    expect(s.totalUniques).toBe(0);
    expect(s.days).toEqual([]);
  });
});

describe("dateWindow", () => {
  it("returns N UTC dates ending at `until`, oldest first", () => {
    expect(dateWindow("2026-06-28", 3)).toEqual(["2026-06-26", "2026-06-27", "2026-06-28"]);
  });
});

describe("parseAdaptiveRows", () => {
  it("lowercases device, maps count→requests and visits", () => {
    const rows = parseAdaptiveRows(ukDayBody);
    expect(rows).toEqual([
      { device: "mobile", requests: 1000, visits: 50 },
      { device: "desktop", requests: 4000, visits: 120 },
    ]);
  });
  it("throws on a GraphQL error body", () => {
    expect(() => parseAdaptiveRows({ errors: [{ message: "range too wide" }] })).toThrow(/range too wide/);
  });
  it("empty groups → []", () => {
    expect(parseAdaptiveRows(emptyUk)).toEqual([]);
  });
});

describe("aggregateUk", () => {
  it("folds per-day rows, surfaces mobile, sorts by requests", () => {
    const rows = parseAdaptiveRows(ukDayBody);
    const agg = aggregateUk([rows, rows, rows], 3, false); // 3 identical days
    expect(agg.mobileVisits).toBe(150);
    expect(agg.mobileRequests).toBe(3000);
    expect(agg.totalVisits).toBe(510);
    expect(agg.byDevice[0].device).toBe("desktop"); // most requests first
    expect(agg.truncated).toBe(false);
  });
});

describe("isoDate", () => {
  it("formats UTC YYYY-MM-DD", () => {
    expect(isoDate(new Date("2026-06-28T15:30:00Z"))).toBe("2026-06-28");
  });
});

describe("fetchUkBreakdown", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps the per-day fan-out at 31 days and flags truncation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonRes(emptyUk));
    vi.stubGlobal("fetch", fetchMock);
    const uk = await fetchUkBreakdown({ token: "t", zoneId: "z", until: "2026-06-28", days: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(31); // one call per capped day
    expect(uk.days).toBe(31);
    expect(uk.truncated).toBe(true);
  });
});

describe("fetchVisitorStats", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("derives the window, then fans out one adaptive call per day", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes(dailyBody)); // daily first
    for (let i = 0; i < 7; i++) fetchMock.mockResolvedValueOnce(jsonRes(ukDayBody)); // 7 GB-device days
    vi.stubGlobal("fetch", fetchMock);

    const s = await fetchVisitorStats({ token: "t", zoneId: "z", days: 7, now: new Date("2026-06-28T00:00:00Z") });
    expect(s.since).toBe("2026-06-22");
    expect(s.until).toBe("2026-06-28");
    expect(s.totalUniques).toBe(250);
    expect(fetchMock).toHaveBeenCalledTimes(1 + 7);
    expect(s.uk?.mobileVisits).toBe(7 * 50);
    expect(s.uk?.mobileRequests).toBe(7 * 1000);
    expect(s.uk?.totalVisits).toBe(7 * 170);
  });

  it("degrades to uk:undefined when an adaptive day fails — totals survive", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes(dailyBody))
      .mockRejectedValue(new Error("adaptive blip"));
    vi.stubGlobal("fetch", fetchMock);

    const s = await fetchVisitorStats({ token: "t", zoneId: "z", now: new Date("2026-06-28T00:00:00Z") });
    expect(s.totalUniques).toBe(250);
    expect(s.uk).toBeUndefined();
  });

  it("throws a status (not the body) on a non-200, so tokens never leak via errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden", json: async () => ({}) }));
    await expect(fetchVisitorStats({ token: "t", zoneId: "z" })).rejects.toThrow(/HTTP 403/);
  });
});
