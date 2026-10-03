// `npm run floplib -- [options]`: bundles the runner and its worker with
// esbuild (the frontend's TypeScript uses extensionless imports, which plain
// Node cannot load) into `.cache/`, then runs the runner with the options.
// See README.md.
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, ".cache");
for (const name of ["run", "worker"]) {
  buildSync({
    entryPoints: [join(here, `${name}.ts`)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(cache, `${name}.mjs`),
    logLevel: "warning",
  });
}
const result = spawnSync(process.execPath, [join(cache, "run.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, FLOPLIB_ROOT: join(here, "../../..") },
});
process.exit(result.status ?? 1);
