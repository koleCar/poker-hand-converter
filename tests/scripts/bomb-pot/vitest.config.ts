// The bomb pot study (analysis/45 follow-up) is not part of `npm test`: it
// reads a local export of someone's hands. Vitest is only the runner.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/bomb-pot/*.test.ts"],
    testTimeout: 12 * 60 * 60_000,
    fileParallelism: false,
  },
});
