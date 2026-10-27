#!/usr/bin/env node
/**
 * The web app's copy of the WebAssembly core (docs/RAIL-PLAN.md R4.1).
 *
 *   npm run wasm:web            build `--target web` and copy it into the web app
 *                               (Linux x86_64 only, see below; refuses elsewhere)
 *   npm run wasm:web-check      the committed copy is whole, and - on Linux
 *                               x86_64 - byte for byte what the sources build
 *   npm run wasm:web-from-ci    take CI's build for this commit (`web-from-ci.mjs`)
 *   node web.mjs --stage <dir>  write the package (with BUILD.json) to <dir>;
 *                               CI uploads it as the artefact `rail-core-web`
 *   node web.mjs --from <dir>   install a package from <dir> (CI's artefact)
 *
 * Vercel builds `web/` and has no Rust, so the wasm-bindgen output the
 * web runs is committed at {@link OUT}: the four files and a `BUILD.json`
 * with the pinned toolchain and every file's sha-256 (a function of those
 * bytes, written by this script, never by hand).
 *
 * **The canonical build is CI's, on Linux x86_64.** The `.wasm` depends on the
 * host that links it: rust-lld on macOS aarch64 merges and lays out the data
 * segments differently from rust-lld on Linux x86_64 (the same strings, packed
 * in another order; 17 bytes apart on 2.28 MB), although sources, toolchain,
 * Cargo.lock and wasm-bindgen are pinned and paths are remapped (`build.mjs`).
 * On Linux x86_64 the build is deterministic - CI's `wasm` job rebuilds it on
 * a fresh runner and compares. So on any other host this script refuses to
 * write over the committed copy (a write is what could end up committed, so
 * it is the step that must not happen), and `--check` there only checks the
 * committed copy against its own BUILD.json and says why it cannot compare.
 * After a change to the core: push, let CI fail `wasm:web-check`, then
 * `npm run wasm:web-from-ci` (or the `gh run download` line CI prints) and
 * commit the directory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PKG = join(ROOT, "core/rail-core-wasm/pkg/web");
export const OUT = join(ROOT, "web/src/lib/wasm/rail-core");

/** What wasm-bindgen writes for `--target web`, all of it shipped. */
export const FILES = ["rail_core_wasm.js", "rail_core_wasm.d.ts", "rail_core_wasm_bg.wasm", "rail_core_wasm_bg.wasm.d.ts"];

/** The one host whose build is committed: what CI's `wasm` job runs on. */
export const CANONICAL_HOST = "x86_64-unknown-linux-gnu";
export const onCanonicalHost = process.platform === "linux" && process.arch === "x64";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toolchain() {
  const text = readFileSync(join(ROOT, "rust-toolchain.toml"), "utf8");
  return /^channel\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
}

function lockedBindgenVersion() {
  const lock = readFileSync(join(ROOT, "Cargo.lock"), "utf8").replace(/\r\n/g, "\n");
  return /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1] ?? null;
}

/** BUILD.json for these four files: a pure function of their bytes and the pins. */
function buildJson(files) {
  const build = {
    "//": "Written by tests/scripts/wasm/web.mjs (docs/RAIL-PLAN.md R4.1). Do not edit; CI rebuilds and compares.",
    host: CANONICAL_HOST,
    rustToolchain: toolchain(),
    wasmBindgen: lockedBindgenVersion(),
    profile: "wasm-release",
    gzip: gzipSync(files.get("rail_core_wasm_bg.wasm"), { level: 9 }).length,
    files: Object.fromEntries(FILES.map((name) => [name, { bytes: files.get(name).length, sha256: sha256(files.get(name)) }])),
  };
  return Buffer.from(`${JSON.stringify(build, null, 2)}\n`);
}

/** The package as it should be committed, from a directory holding the four files. */
function packageFrom(dir, hint) {
  const missing = FILES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    fail(`${relative(ROOT, dir) || dir} has no ${missing.join(", ")}${hint ? `: ${hint}` : ""}`);
  }
  const files = new Map(FILES.map((name) => [name, readFileSync(join(dir, name))]));
  files.set("BUILD.json", buildJson(files));
  return files;
}

function write(dir, files) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of files) {
    writeFileSync(join(dir, name), bytes);
  }
}

/** Differences between `want` and what `dir` holds. */
function differences(dir, want) {
  const problems = [];
  const have = existsSync(dir) ? readdirSync(dir) : [];
  for (const [name, bytes] of want) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      problems.push(`${name}: missing`);
    } else if (!readFileSync(path).equals(bytes)) {
      problems.push(`${name}: sha-256 ${sha256(readFileSync(path)).slice(0, 16)}..., expected ${sha256(bytes).slice(0, 16)}...`);
    }
  }
  for (const name of have) {
    if (!want.has(name)) {
      problems.push(`${name}: not part of the package`);
    }
  }
  return problems;
}

function fail(message) {
  console.error(`wasm:web: ${message}`);
  process.exit(1);
}

const NOT_CANONICAL =
  `this is ${process.platform} ${process.arch}; the committed core is the ${CANONICAL_HOST} build ` +
  "(CI's), and a build here is laid out differently by the linker, so it cannot match and must not be committed.";

/** How to take CI's build, for the messages. */
function takeCiBuild() {
  const run = process.env.GITHUB_RUN_ID;
  const download = `gh run download ${run ?? "<run id>"} -n rail-core-web -D web/src/lib/wasm/rail-core`;
  return (
    "Take CI's Linux build (the canonical one) and commit it:\n" +
    "  cd tests && npm run wasm:web-from-ci\n" +
    "or, from the repository root:\n" +
    `  rm -rf web/src/lib/wasm/rail-core && ${download}`
  );
}

function main(argv) {
  const at = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1] ?? fail(`${flag} needs a directory`);
  };

  const from = at("--from");
  if (from !== null) {
    // CI's artefact: already the canonical bytes, so allowed on any host.
    const dir = resolve(from);
    const files = packageFrom(dir);
    if (existsSync(join(dir, "BUILD.json")) && !readFileSync(join(dir, "BUILD.json")).equals(files.get("BUILD.json"))) {
      fail(`${dir}/BUILD.json does not describe the files next to it (another toolchain or wasm-bindgen pin?)`);
    }
    write(OUT, files);
    console.log(`wasm:web: installed ${relative(ROOT, OUT)} from ${dir} (wasm sha-256 ${sha256(files.get("rail_core_wasm_bg.wasm")).slice(0, 16)}...)`);
    return;
  }

  const stage = at("--stage");
  if (stage !== null) {
    if (!onCanonicalHost) {
      fail(NOT_CANONICAL);
    }
    write(resolve(stage), packageFrom(PKG, "run `npm run wasm:build -- web` first"));
    console.log(`wasm:web: staged the web package in ${resolve(stage)}`);
    return;
  }

  if (argv.includes("--check")) {
    // Anywhere: the committed copy is whole and its BUILD.json is the one this
    // script writes for those bytes (no hand edit, no file missing or extra).
    const committed = packageFrom(OUT, "the committed web package is incomplete");
    const problems = differences(OUT, committed);
    if (problems.length > 0) {
      fail(`${relative(ROOT, OUT)} does not match its BUILD.json:\n  ${problems.join("\n  ")}\n${takeCiBuild()}`);
    }
    if (!onCanonicalHost) {
      console.log(`wasm:web: ${relative(ROOT, OUT)} is whole. Not compared with a build: ${NOT_CANONICAL}`);
      return;
    }
    const fresh = packageFrom(PKG, "run `npm run wasm:build -- web` first");
    const stale = differences(OUT, fresh);
    if (stale.length > 0) {
      fail(`${relative(ROOT, OUT)} is not what the sources build:\n  ${stale.join("\n  ")}\n${takeCiBuild()}`);
    }
    console.log(`wasm:web: ${relative(ROOT, OUT)} is what the sources build (${fresh.size} files).`);
    return;
  }

  if (!onCanonicalHost) {
    fail(`refusing to write ${relative(ROOT, OUT)}: ${NOT_CANONICAL}\n${takeCiBuild()}`);
  }
  const build = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "build.mjs"), "web"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
  const files = packageFrom(PKG, "run `npm run wasm:build -- web` first");
  write(OUT, files);
  console.log(`wasm:web: ${relative(ROOT, OUT)}: wasm sha-256 ${sha256(files.get("rail_core_wasm_bg.wasm")).slice(0, 16)}...`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
