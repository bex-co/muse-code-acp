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
      // Floors of the 2026-10-15 CI baseline, measured without a Muse host as
      // the CI build job runs (85.82/77.57/86.9/87.61); live-echo tests that
      // run where Muse is installed only add coverage. Raise, never lower.
      thresholds: { statements: 85, branches: 77, functions: 86, lines: 87 },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
