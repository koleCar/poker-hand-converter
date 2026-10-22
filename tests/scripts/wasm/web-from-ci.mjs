#!/usr/bin/env node
/**
 * `npm run wasm:web-from-ci [-- --run <id>]`: install CI's build of the web
 * package (docs/RAIL-PLAN.md R4.1) for the commit checked out here.
 *
 * The committed `.wasm` is the Linux x86_64 build CI makes (`web.mjs` says
 * why no other host's build can be committed). After a change to the core,
 * push; CI's `wasm` job fails `wasm:web-check` and uploads its build as the
 * artefact `rail-core-web` (the four files and BUILD.json). This finds the
 * newest `CI` run of this branch at this commit, downloads that artefact with
 * the GitHub CLI and installs it through `web.mjs --from`, which checks
 * BUILD.json against the bytes. Then commit `frontend/src/lib/wasm/rail-core/`;
 * CI rebuilds and compares on the next push.
 *
 * `--run <id>` takes a specific run instead (any commit - make sure its core
 * sources are the ones checked out).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.error) {
    console.error(`wasm:web-from-ci: ${command} could not run (${result.error.message}); the GitHub CLI (gh) is required`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`wasm:web-from-ci: ${command} ${args.join(" ")} failed:\n${result.stderr ?? ""}`);
    process.exit(result.status ?? 1);
  }
  return (result.stdout ?? "").trim();
}

const argv = process.argv.slice(2);
const asked = argv.includes("--run") ? argv[argv.indexOf("--run") + 1] : null;

let runId = asked;
if (!runId) {
  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = run("git", ["rev-parse", "HEAD"]);
  const runs = JSON.parse(
    run("gh", ["run", "list", "--branch", branch, "--workflow", "CI", "--limit", "30", "--json", "databaseId,headSha,status,createdAt"]),
  );
  const mine = runs.filter((r) => r.headSha === head);
  if (mine.length === 0) {
    console.error(
      `wasm:web-from-ci: no CI run of ${branch} at ${head.slice(0, 9)}. Push this commit and wait for the ` +
        "`wasm` job (it uploads `rail-core-web`), or pass `--run <id>`.",
    );
    process.exit(1);
  }
  runId = String(mine[0].databaseId);
  console.log(`wasm:web-from-ci: run ${runId} (${branch} at ${head.slice(0, 9)}, ${mine[0].status})`);
}

const dir = mkdtempSync(join(tmpdir(), "rail-core-web-"));
try {
  run("gh", ["run", "download", runId, "-n", "rail-core-web", "-D", dir], { stdio: ["ignore", "inherit", "pipe"] });
  run(process.execPath, [join(HERE, "web.mjs"), "--from", dir], { stdio: ["ignore", "inherit", "inherit"] });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("wasm:web-from-ci: commit frontend/src/lib/wasm/rail-core/");
