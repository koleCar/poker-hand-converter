// The preflop chart generator is not part of `npm test`: it runs for minutes
// and writes the committed chart set. Run it with `npm run charts:generate`
// from `tests/` (see docs/CHARTS.md). Vitest is only the runner here, as for
// the solver benchmark: it resolves the frontend's extensionless imports
// without a build step.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/preflop-charts/*.test.ts"],
    // Every set from scratch, several at a time, takes hours.
    testTimeout: 12 * 60 * 60_000,
    fileParallelism: false,
  },
});
