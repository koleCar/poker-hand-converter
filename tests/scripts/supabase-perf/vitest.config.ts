import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/supabase-perf/*.test.ts"],
    testTimeout: 4 * 60 * 60_000,
    fileParallelism: false,
  },
});
