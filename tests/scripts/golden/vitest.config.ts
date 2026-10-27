// The golden oracle (`npm run golden:emit` from `tests/`, docs/RAIL-PLAN.md
// R0.3): not part of `npm test`. Vitest is only the runner, as for the chart
// and flop-library scripts: it resolves the web's extensionless imports
// without a build. CI's `golden-fresh` job runs it and fails when the output
// differs from what is committed under `testdata/golden/`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/golden/*.test.ts"],
    testTimeout: 30 * 60_000,
    fileParallelism: false,
  },
});
