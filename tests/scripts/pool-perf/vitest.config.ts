import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/pool-perf/*.test.ts"],
    testTimeout: 10 * 60_000,
    fileParallelism: false,
  },
});
