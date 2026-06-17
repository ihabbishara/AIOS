import { describe, it, expect } from "vitest";
import { Store } from "../src/store/db.js";
import { CATEGORIES, normalize, matchRuleCategory, defaultCategory, makeCategorizer } from "../src/money/categorize.js";

const tx = (over = {}) => ({ account_id: "acc1", bunq_id: 1, amount_cents: -1099, description: "card payment", counterparty: "Albert Heijn 1234", ...over });

describe("categorize helpers", () => {
  it("taxonomy is the fixed set incl. 'other'", () => {
    expect(CATEGORIES).toContain("groceries");
    expect(CATEGORIES).toContain("other");
  });
  it("default merchant map hits known NL merchants", () => {
    expect(defaultCategory(normalize("Albert Heijn 1234"), normalize("card"))).toBe("groceries");
    expect(defaultCategory(normalize("NS Reizigers"), normalize("ov"))).toBe("transport");
    expect(defaultCategory(normalize("Some Random Shop"), normalize("x"))).toBeUndefined();
  });
  it("rule match is normalized contains", () => {
    expect(matchRuleCategory([{ pattern: "albert heijn", category: "groceries" }], "ALBERT HEIJN 1234", "card")).toBe("groceries");
  });
});

describe("makeCategorizer ordering", () => {
  it("cache short-circuits (no rule/default/llm consulted)", async () => {
    const s = new Store(":memory:");
    s.setTxCategory("acc1", 1, "entertainment", "llm");
    let llmCalls = 0;
    const cat = makeCategorizer(s, async () => { llmCalls++; return "other"; });
    expect(await cat(tx())).toBe("entertainment");
    expect(llmCalls).toBe(0);
  });
  it("DB rule beats default and is cached as 'rule'", async () => {
    const s = new Store(":memory:");
    s.upsertCategoryRule("albert heijn", "shopping", "user"); // override the default 'groceries'
    const cat = makeCategorizer(s, async () => "other");
    expect(await cat(tx())).toBe("shopping");
    expect(s.getTxCategory("acc1", 1)).toMatchObject({ category: "shopping", source: "rule" });
  });
  it("default beats LLM and is cached as 'default'", async () => {
    const s = new Store(":memory:");
    let llmCalls = 0;
    const cat = makeCategorizer(s, async () => { llmCalls++; return "other"; });
    expect(await cat(tx())).toBe("groceries"); // Albert Heijn default
    expect(llmCalls).toBe(0);
    expect(s.getTxCategory("acc1", 1)!.source).toBe("default");
  });
  it("unknown merchant → LLM, then cached + learned as a rule", async () => {
    const s = new Store(":memory:");
    const cat = makeCategorizer(s, async () => "health");
    expect(await cat(tx({ counterparty: "Apotheek Zuid", description: "pharmacy" }))).toBe("health");
    expect(s.getTxCategory("acc1", 1)).toMatchObject({ category: "health", source: "llm" });
    expect(s.listCategoryRules().some((r) => r.category === "health" && r.source === "llm")).toBe(true); // learned
  });
  it("LLM failure → 'other', not cached (so it retries later)", async () => {
    const s = new Store(":memory:");
    const cat = makeCategorizer(s, async () => { throw new Error("llm down"); });
    expect(await cat(tx({ counterparty: "Unknownco", description: "x" }))).toBe("other");
    expect(s.getTxCategory("acc1", 1)).toBeUndefined();
  });
});
