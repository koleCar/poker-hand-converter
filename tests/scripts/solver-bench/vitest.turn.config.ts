// The turn benchmark (A5a) is not part of `npm test`: it runs for several
// minutes and measures a machine, not a property. Run it with
// `npm run bench:turn`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/solver-bench/turn.test.ts"],
    testTimeout: 60 * 60_000,
    // One file, one worker: nothing else competing for the core being timed.
    fileParallelism: false,
  },
});
