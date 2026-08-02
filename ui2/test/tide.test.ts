// ui2/test/tide.test.ts — the anti-twitch gate. A level must not change on a
// blip; agents finish turns constantly and the page must not jump.
import { describe, it, expect } from "vitest";
import { tideLevel, tideInit, tideStep, TIDE_DWELL_MS } from "../src/lib/tide.js";

describe("tideLevel", () => {
  it("maps working count to three discrete levels", () => {
    expect(tideLevel(0)).toBe("low");
    expect(tideLevel(1)).toBe("mid");
    expect(tideLevel(2)).toBe("mid");
    expect(tideLevel(3)).toBe("high");
    expect(tideLevel(11)).toBe("high");
  });
});

describe("tideStep hysteresis", () => {
  it("holds the level until the new one has persisted for the dwell", () => {
    let s = tideInit(0);
    expect(s.level).toBe("low");
    s = tideStep(s, 3, 1000);           // high appears
    expect(s.level).toBe("low");        // not yet
    s = tideStep(s, 3, 1000 + TIDE_DWELL_MS - 1);
    expect(s.level).toBe("low");        // still not
    s = tideStep(s, 3, 1000 + TIDE_DWELL_MS);
    expect(s.level).toBe("high");       // committed
  });

  it("six count changes inside 4s produce zero level changes", () => {
    let s = tideInit(0);
    const counts = [3, 0, 4, 1, 5, 0];
    counts.forEach((c, i) => { s = tideStep(s, c, 500 * (i + 1)); });
    expect(s.level).toBe("low");
  });

  it("a return to the committed level cancels a pending change", () => {
    let s = tideInit(0);
    s = tideStep(s, 3, 1000);
    expect(s.pending).toBe("high");
    s = tideStep(s, 0, 2000);
    expect(s.pending).toBe(null);
    s = tideStep(s, 0, 2000 + TIDE_DWELL_MS * 2);
    expect(s.level).toBe("low");
  });

  it("restarts the dwell when the pending level itself changes", () => {
    let s = tideInit(0);
    s = tideStep(s, 3, 1000);                     // pending high
    s = tideStep(s, 1, 1000 + TIDE_DWELL_MS - 1); // pending flips to mid, clock restarts
    expect(s.pending).toBe("mid");
    s = tideStep(s, 1, 1000 + TIDE_DWELL_MS + 1); // dwell measured from the flip, not the first
    expect(s.level).toBe("low");
    s = tideStep(s, 1, 1000 + TIDE_DWELL_MS * 2);
    expect(s.level).toBe("mid");
  });
});
