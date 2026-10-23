import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    alias: { "@rail/ui": fileURLToPath(new URL("../../../packages/ui", import.meta.url)) },
  },
  test: {
    include: ["scripts/share-names/*.test.ts"],
    testTimeout: 5 * 60_000,
    fileParallelism: false,
  },
});
