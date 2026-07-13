// test/policy-wiring.test.ts
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { EventBus } from "../src/events.js";
import { Policy } from "../src/kernel/policy.js";
import { loadConfig } from "../src/config.js";

describe("policy wiring", () => {
  it("config defaults to audit; 'enforce' opts in", () => {
    const prev = process.env.AIOS_POLICY_MODE;
    delete process.env.AIOS_POLICY_MODE;
    expect(loadConfig("/tmp/x").policyMode).toBe("audit");
    process.env.AIOS_POLICY_MODE = "enforce";
    expect(loadConfig("/tmp/x").policyMode).toBe("enforce");
    process.env.AIOS_POLICY_MODE = "garbage";
    expect(loadConfig("/tmp/x").policyMode).toBe("audit");
    if (prev === undefined) delete process.env.AIOS_POLICY_MODE; else process.env.AIOS_POLICY_MODE = prev;
  });

  it("a reported violation reaches the bus as a policy.violation event (no content)", () => {
    const store = new Store(":memory:");
    const bus = new EventBus(store);
    const seen: unknown[] = [];
    bus.on((e) => seen.push(e.event));
    const policy = new Policy({ mode: "audit", report: (v) => bus.emit({ type: "policy.violation", ...v }) });
    policy.check({ labels: ["personal.finance"], sink: "recall-index" }, "test:site", "SECRET_BODY");
    const ev = seen.find((e) => (e as { type: string }).type === "policy.violation") as Record<string, unknown>;
    expect(ev).toBeTruthy();
    expect(ev.sink).toBe("recall-index");
    expect(ev.site).toBe("test:site");
    expect(JSON.stringify(ev)).not.toContain("SECRET_BODY");
  });
});
