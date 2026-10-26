// The push/fold equity table generator (R5.5) is not part of `npm test`: it
// samples a million boards (minutes) and writes the committed table
// `frontend/src/lib/analysis/data/pushFoldEquity.ts`. Run it with
// `npm run icm:equity` from `tests/` (docs/CHARTS.md §13). Vitest is only the
// runner, as for the chart generator.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/icm/*.test.ts"],
    testTimeout: 2 * 60 * 60_000,
    fileParallelism: false,
  },
});
