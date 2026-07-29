// test/onboarding-wizard.test.ts — linear resumable step machine (spec §1).
import { describe, it, expect } from "vitest";
import { Wizard, STEPS, type Step } from "../src/onboarding/wizard.js";

function kv() {
  const m = new Map<string, string>();
  return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) };
}

describe("Wizard", () => {
  it("starts at welcome and advances in spec order", () => {
    const w = new Wizard(kv());
    expect(w.current()).toBe("welcome");
    expect(w.advance("welcome")).toBe("auth");
    expect(w.current()).toBe("auth");
  });

  it("rejects advance from a stale step", () => {
    const w = new Wizard(kv());
    w.advance("welcome");
    expect(() => w.advance("welcome")).toThrow(/current step is auth/);
  });

  it("resumes from persisted state (new instance, same kv)", () => {
    const store = kv();
    new Wizard(store).advance("welcome");
    expect(new Wizard(store).current()).toBe("auth");
  });

  it("goes back only to earlier steps", () => {
    const w = new Wizard(kv());
    w.advance("welcome");
    expect(w.goBack("welcome")).toBe("welcome");
    expect(() => w.goBack("review")).toThrow(/cannot go back/);
  });

  it("refuses a goBack target that is not a step, leaving kv untouched", () => {
    const w = new Wizard(kv());
    w.advance("welcome");
    expect(() => w.goBack("bogus" as Step)).toThrow(/cannot go back/);
    expect(w.current()).toBe("auth");
  });

  it("done is terminal", () => {
    const store = kv();
    store.kvSet("onboarding.step", "done");
    expect(() => new Wizard(store).advance("done")).toThrow(/terminal/);
  });

  it("ignores garbage persisted values", () => {
    const store = kv();
    store.kvSet("onboarding.step", "bogus");
    expect(new Wizard(store).current()).toBe("welcome");
  });

  it("step list matches the spec exactly", () => {
    expect([...STEPS]).toEqual(["welcome", "auth", "workspace", "interview", "review", "provision", "first-job", "done"]);
  });
});
