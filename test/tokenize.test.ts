import { describe, it, expect } from "vitest";
import { tokenize } from "../src/memory/tokenize.js";

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumeric, drops stopwords and short tokens", () => {
    // "the" dropped (stopword); "dropped" stays (only plural -s is stemmed); "12%" -> "12"
    expect(tokenize("The LNG spot-price dropped 12%!")).toEqual(["lng", "spot", "price", "dropped", "12"]);
  });
  it("strips accents", () => {
    expect(tokenize("Café señor")).toEqual(["cafe", "senor"]);
  });
  it("light-stems trailing plural s only", () => {
    expect(tokenize("invoices prices")).toEqual(["invoice", "price"]);
    expect(tokenize("address")).toEqual(["address"]); // -ss is not stemmed
  });
  it("returns [] for punctuation-only / empty input (no throw)", () => {
    expect(tokenize("!!! --- ???")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });
  it("drops tokens longer than 40 chars", () => {
    expect(tokenize("a".repeat(50))).toEqual([]);
  });
  it("keeps numeric-only tokens", () => {
    expect(tokenize("paid 99 and 1234 today")).toEqual(["paid", "99", "1234", "today"]);
  });
  it("drops non-latin text (documented lexical limitation)", () => {
    expect(tokenize("中文 ℓ")).toEqual([]);
  });
});
