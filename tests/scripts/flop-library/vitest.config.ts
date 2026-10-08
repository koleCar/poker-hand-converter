// The flop library's measurement over a stored library is not part of
// `npm test`: it needs a local export of someone's hands and the full
// library on disk. Run it with `npm run floplib:measure` from `tests/` (see
// README.md). Vitest is only the runner here, as for the chart scripts: it
// resolves the frontend's extensionless imports without a build step.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/flop-library/*.test.ts"],
    testTimeout: 12 * 60 * 60_000,
    fileParallelism: false,
  },
});
