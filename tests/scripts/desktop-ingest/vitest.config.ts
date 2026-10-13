import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/desktop-ingest/*.test.ts"],
    testTimeout: 30 * 60_000,
    fileParallelism: false,
  },
});
