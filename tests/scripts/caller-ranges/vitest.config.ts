// The caller-range study (ANALYSIS-PLAN §10, analysis/19) is not part of
// `npm test`: it reads a local export of someone's hands. Run it with
// `npm run ranges:callers` from `tests/` (see shown.test.ts). Vitest is only
// the runner, as for the chart and flop-library scripts.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/caller-ranges/*.test.ts"],
    testTimeout: 12 * 60 * 60_000,
    fileParallelism: false,
  },
});
