import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The web's dictionaries (`frontend/src/lib/i18n/`) take the replayer's
    // words and the Croatian `plural` from the shared UI package by its name
    // (R2.7a); the web resolves it through its `file:` dependency, the
    // harness here.
    alias: { "@rail/ui": fileURLToPath(new URL("../packages/ui", import.meta.url)) },
  },
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
