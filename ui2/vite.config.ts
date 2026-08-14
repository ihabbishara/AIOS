/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://localhost:4280" } },
  // setupFiles: jsdom's Blob is missing text()/arrayBuffer() — see test/setup.ts.
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] },
});
