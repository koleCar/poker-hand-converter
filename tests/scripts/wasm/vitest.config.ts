// WASM shadow mode (`npm run wasm:shadow` from `tests/`, docs/RAIL-PLAN.md
// R0.13): the WebAssembly core next to the TypeScript pipeline over the whole
// corpus. Needs `npm run wasm:build` first, so it is not part of `npm test`;
// CI's `wasm` job runs both.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["scripts/wasm/*.test.ts"],
    testTimeout: 30 * 60_000,
    fileParallelism: false,
  },
});
