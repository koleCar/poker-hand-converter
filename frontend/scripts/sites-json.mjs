/**
 * Publishes `config/sites.json` at `/sites.json` on the web origin
 * (docs/RAIL-PLAN.md R3.10): the desktop app fetches it to keep its HUD policy
 * current without a release - and a downloaded copy can only make the policy
 * stricter than the app's own (`rail_config::load_remote`).
 *
 * The repository's `config/sites.json` stays the only source: this copies it,
 * byte for byte, to `public/sites.json` (gitignored) before `next dev` and
 * `next build`, so the file the web serves is always the one in the commit
 * that was deployed. To change what the app reads: edit `config/sites.json`
 * in a pull request (the schema test and the Rust validator check it), merge,
 * and let the web deploy.
 *
 * It refuses to publish a file that is not JSON or is not version 1, so a
 * broken edit fails the web build instead of reaching the apps (which would
 * refuse it anyway and keep their last good copy).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "config", "sites.json");
const target = join(here, "..", "public", "sites.json");

const text = readFileSync(source, "utf8");
const parsed = JSON.parse(text);
if (parsed.version !== 1 || !Array.isArray(parsed.sites) || parsed.sites.length === 0) {
  throw new Error(`${source}: not a version 1 sites.json`);
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text);
console.log(`sites.json: ${parsed.sites.length} entries published at /sites.json`);
