// vitest.config.ts — pin the root suite to test/ so ui2's jsdom tests stay in ui2's own runner.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
