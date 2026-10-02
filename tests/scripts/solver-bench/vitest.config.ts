// The solver benchmark is not part of `npm test`: it runs for a minute or more
// and measures a machine, not a property. Run it with `npm run bench:solver`.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/solver-bench/bench.test.ts"],
    testTimeout: 30 * 60_000,
    // One file, one worker: nothing else competing for the core being timed.
    fileParallelism: false,
  },
});
