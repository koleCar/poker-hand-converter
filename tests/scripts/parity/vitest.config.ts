// The web/app parity test (`npm run parity` from `tests/`, docs/RAIL-PLAN.md
// R4.4): the same corpus files through the desktop app's path and the web's
// bulk upload into a local Supabase stack, the stored rows compared. Needs
// the stack, `web/node_modules` and cargo, so not part of `npm test`;
// CI runs it in its own job ("Web/app parity").
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  resolve: {
    // As in `tests/vitest.config.ts`: the web's code takes words from the
    // shared UI package by its name.
    alias: { "@rail/ui": fileURLToPath(new URL("../../../packages/ui", import.meta.url)) },
  },
  test: {
    include: ["scripts/parity/*.test.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
});
