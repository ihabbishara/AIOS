// ui2/test/smoke.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { App } from "../src/App.js";

describe("scaffold", () => {
  it("renders the calm empty line", () => {
    const { getByText } = render(<App />);
    expect(getByText("Nothing needs you.")).toBeTruthy();
  });
});
