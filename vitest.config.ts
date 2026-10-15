import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    // Many tests spawn fake Muse hosts. With one worker per core those spawns
    // contend, so the 5s/1s defaults fail correct tests on loaded machines.
    testTimeout: 15_000,
    expect: { poll: { timeout: 10_000 } },
    include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**"],
      // Baseline floors from 2026-10-15 (86.29/78.22/87.5/88.05); raise, never lower.
      thresholds: { statements: 86, branches: 78, functions: 87, lines: 88 },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
