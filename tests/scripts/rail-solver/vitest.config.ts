// Parity fixtures for the native solver (core/rail-solver, docs/NODELOCK.md
// §2.5): `npm run solver:fixtures` from `tests/` rewrites the small ones the
// Rust tests read (core/rail-solver/tests/fixtures); with RAIL_SOLVER_BIG=1 it
// also writes the real flop-m1 spot to target/rail-solver-fixtures (minutes of
// TypeScript solving, never committed). Not part of `npm test`. Vitest is only
// the runner: it resolves the web's extensionless imports without a build.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/rail-solver/*.test.ts"],
    testTimeout: 2 * 60 * 60_000,
    fileParallelism: false,
  },
});
