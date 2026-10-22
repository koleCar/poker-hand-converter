// Bulk upload at desktop scale (`npm run bulk-upload:measure` from `tests/`,
// docs/RAIL-PLAN.md R4.2): a synthetic zip of ~1M corpus hands, built in a
// temporary directory, read and converted the way the converter's worker
// does. Minutes of CPU, so not part of `npm test`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/bulk-upload/*.test.ts"],
    testTimeout: 60 * 60_000,
    fileParallelism: false,
  },
});
