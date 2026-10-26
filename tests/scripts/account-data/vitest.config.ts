import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npm run account:measure` (docs/RAIL-PLAN.md R6.5): the export and the
// deletion of a big account against a local stack. Not in CI.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: {
      "@rail/ui": fileURLToPath(new URL("../../../packages/ui", import.meta.url)),
    },
  },
  test: {
    include: ["scripts/account-data/*.test.ts"],
    testTimeout: 4 * 60 * 60_000,
    fileParallelism: false,
  },
});
