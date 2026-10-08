// The Learn L3 direction check (`npm run learn:directions` from `tests/`):
// not part of `npm test`, it solves a few dozen turns and a few hundred
// rivers. Vitest is only the runner, as for the chart and flop-library
// scripts: it resolves the frontend's extensionless imports without a build.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/learn-directions/*.test.ts"],
    testTimeout: 6 * 60 * 60_000,
    fileParallelism: false,
  },
});
