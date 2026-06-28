import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isoDate,
  parseDaily,
  parseMobileShare,
  fetchVisitorStats,
} from "../src/senses/cloudflare/analytics.js";

const dailyBody = {
  data: { viewer: { zones: [{ httpRequests1dGroups: [
    { dimensions: { date: "2026-06-26" }, uniq: { uniques: 100 }, sum: { pageViews: 400, requests: 900 } },
    { dimensions: { date: "2026-06-27" }, uniq: { uniques: 150 }, sum: { pageViews: 600, requests: 1200 } },
  ] }] } },
};

const deviceBody = {
  data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
    { count: 700, dimensions: { clientDeviceType: "mobile" } },
    { count: 300, dimensions: { clientDeviceType: "desktop" } },
  ] }] } },
};

describe("parseDaily", () => {
  it("maps days and sums totals", () => {
    const s = parseDaily(dailyBody, "zone1", "2026-06-26", "2026-06-27");
    expect(s.days).toHaveLength(2);
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

describe("parseMobileShare", () => {
  it("computes the mobile fraction of sampled requests", () => {
    expect(parseMobileShare(deviceBody)).toBeCloseTo(0.7);
  });
  it("is undefined when no device data", () => {
    expect(parseMobileShare({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [] }] } } })).toBeUndefined();
  });
});

describe("isoDate", () => {
  it("formats UTC YYYY-MM-DD", () => {
    expect(isoDate(new Date("2026-06-28T15:30:00Z"))).toBe("2026-06-28");
  });
});

describe("fetchVisitorStats", () => {
  afterEach(() => vi.unstubAllGlobals());

  const jsonRes = (body: unknown) => ({ ok: true, status: 200, statusText: "OK", json: async () => body });

  it("derives the date window from `now` and merges daily + device", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes(dailyBody))   // daily query
      .mockResolvedValueOnce(jsonRes(deviceBody)); // device query
    vi.stubGlobal("fetch", fetchMock);

    const s = await fetchVisitorStats({ token: "t", zoneId: "z", days: 7, now: new Date("2026-06-28T00:00:00Z") });
    expect(s.since).toBe("2026-06-22");
    expect(s.until).toBe("2026-06-28");
    expect(s.totalUniques).toBe(250);
    expect(s.mobileShare).toBeCloseTo(0.7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to mobileShare:undefined when the device query fails — totals survive", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonRes(dailyBody))
      .mockRejectedValueOnce(new Error("adaptive dataset gated"));
    vi.stubGlobal("fetch", fetchMock);

    const s = await fetchVisitorStats({ token: "t", zoneId: "z", now: new Date("2026-06-28T00:00:00Z") });
    expect(s.totalUniques).toBe(250);
    expect(s.mobileShare).toBeUndefined();
  });

  it("throws a status (not the body) on a non-200, so tokens never leak via errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden", json: async () => ({}) }));
    await expect(fetchVisitorStats({ token: "t", zoneId: "z" })).rejects.toThrow(/HTTP 403/);
  });
});
