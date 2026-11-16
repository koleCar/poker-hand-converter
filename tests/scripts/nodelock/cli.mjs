// `node scripts/nodelock/cli.mjs [options]` from `tests/`: bundles the
// nodelock timing harness and its worker with esbuild (the web's TypeScript
// uses extensionless imports, which plain Node cannot load) into `.cache/`,
// then runs it. See `bench.ts` for the options. It solves one real flop
// spot - minutes of every core - so run it only when nothing else is
// measuring.
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, ".cache");
for (const name of ["bench", "worker"]) {
  buildSync({
    entryPoints: [join(here, `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(cache, `${name}.mjs`),
    logLevel: "warning",
  });
}
const result = spawnSync(process.execPath, ["--max-old-space-size=8192", join(cache, "bench.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODELOCK_ROOT: join(here, "../../..") },
});
process.exit(result.status ?? 1);
