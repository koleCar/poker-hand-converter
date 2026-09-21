import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // The suites are deliberately table-driven over whole corpora - 435
    // fixtures and 6400+ hands - so a single `it` legitimately runs for
    // seconds. Vitest's 5s default passed in isolation and failed under
    // parallel load, which is the worst shape of flake: it looks like a
    // regression in whichever change happens to be in flight.
    testTimeout: 30_000,
  },
});
