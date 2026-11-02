// `npm run floplib:full -- [options]`: bundles full.ts like cli.mjs does and runs it.
import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, ".cache", "full.mjs");
buildSync({ entryPoints: [join(here, "full.ts")], bundle: true, platform: "node", format: "esm", outfile, logLevel: "warning" });
const result = spawnSync(process.execPath, ["--max-old-space-size=8192", outfile, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, FLOPLIB_ROOT: join(here, "../../..") },
});
process.exit(result.status ?? 1);
