// `node tests/scripts/preflop-v0/cli.mjs [options]` (`run.ts`'s header has
// them; `--help` lists them and solves nothing): bundles the v0 runner and
// the realisation worker with esbuild (the web's TypeScript uses
// extensionless imports, which plain Node cannot load) into `.cache/`, then
// runs the runner with the options. esbuild itself stays external: the
// bundle resolves it from tests/node_modules.
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, ".cache");
const build = (entry, out) =>
  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(cache, out),
    external: ["esbuild"],
    logLevel: "warning",
  });
build(join(here, "run.ts"), "run.mjs");
build(join(here, "../preflop-charts/worker.ts"), "worker.mjs");
const result = spawnSync(process.execPath, [join(cache, "run.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, RAIL_V0_WORKER: join(cache, "worker.mjs") },
});
process.exit(result.status ?? 1);
