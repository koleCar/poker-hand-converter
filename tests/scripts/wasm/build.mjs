#!/usr/bin/env node
/**
 * `npm run wasm:build [-- <target>...]`: builds the WebAssembly core
 * (docs/RAIL-PLAN.md R0.13) and checks its size budget.
 *
 *   cargo build -p rail-core-wasm --target wasm32-unknown-unknown --profile wasm-release --locked
 *   wasm-bindgen --target <target> --out-dir core/rail-core-wasm/pkg/<target> ...
 *
 * Targets: `nodejs` (default; the shadow-mode harness) and `web` (the web
 * app's worker, R4.1). The output under `core/rail-core-wasm/pkg/` is
 * gitignored: it is a pure function of the sources, the pinned toolchain and
 * the pinned wasm-bindgen, and CI rebuilds it.
 *
 * `wasm-bindgen-cli` must be exactly the version of the `wasm-bindgen` crate
 * in Cargo.lock (the glue and the macro share a schema); this script refuses
 * any other and prints the install command. No `wasm-opt` pass: the budget
 * holds without one (R0.13 as built), and an unpinned system binaryen would
 * make the output depend on the machine.
 *
 * Fails when the gzipped `.wasm` is over {@link BUDGET_GZIP} bytes.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CRATE = "rail-core-wasm";
const PKG = join(ROOT, "core/rail-core-wasm/pkg");
const WASM_IN = join(ROOT, "target/wasm32-unknown-unknown/wasm-release/rail_core_wasm.wasm");
const TARGETS = new Set(["nodejs", "web"]);

/** The plan's target: under 1.5 MB gzipped (docs/RAIL-PLAN.md R0.13). */
export const BUDGET_GZIP = 1_500_000;

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(`wasm:build: ${command} ${args.join(" ")} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function lockedBindgenVersion() {
  const lock = readFileSync(join(ROOT, "Cargo.lock"), "utf8");
  const match = /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock.replace(/\r\n/g, "\n"));
  if (!match) {
    throw new Error("wasm:build: no wasm-bindgen package in Cargo.lock");
  }
  return match[1];
}

function installedBindgenVersion() {
  const result = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  return /wasm-bindgen (\S+)/.exec(result.stdout)?.[1] ?? null;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push("nodejs");
}
for (const target of targets) {
  if (!TARGETS.has(target)) {
    console.error(`wasm:build: unknown target ${target} (one of: ${[...TARGETS].join(", ")})`);
    process.exit(2);
  }
}

const wanted = lockedBindgenVersion();
const installed = installedBindgenVersion();
if (installed !== wanted) {
  console.error(
    `wasm:build: wasm-bindgen-cli ${wanted} is required (Cargo.lock), found ${installed ?? "none"}.\n` +
      `  cargo install wasm-bindgen-cli --version ${wanted} --locked`,
  );
  process.exit(1);
}

const started = performance.now();
run("cargo", ["build", "-p", CRATE, "--target", "wasm32-unknown-unknown", "--profile", "wasm-release", "--locked"]);
for (const target of targets) {
  // The function-name section is ~0.9 MB raw (~0.1 MB gzipped) of symbol
  // names for stack traces; `twiggy` on the cargo output above still has
  // them when the size needs explaining.
  run("wasm-bindgen", [
    "--target",
    target,
    "--remove-name-section",
    "--remove-producers-section",
    "--out-dir",
    join(PKG, target),
    WASM_IN,
  ]);
}

const wasm = readFileSync(join(PKG, targets[0], "rail_core_wasm_bg.wasm"));
const gzipped = gzipSync(wasm, { level: 9 }).length;
const size = {
  wasmBindgen: wanted,
  raw: wasm.length,
  gzip: gzipped,
  // What a CDN that serves brotli (Vercel does) sends; for information.
  brotli: brotliCompressSync(wasm, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  budgetGzip: BUDGET_GZIP,
  seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
};
mkdirSync(PKG, { recursive: true });
writeFileSync(join(PKG, "size.json"), `${JSON.stringify(size, null, 2)}\n`);
const mb = (n) => (n / 1e6).toFixed(2);
console.log(
  `wasm:build: ${targets.join(", ")}: rail_core_wasm_bg.wasm ${mb(size.raw)} MB raw, ` +
    `${mb(size.gzip)} MB gzipped (budget ${mb(BUDGET_GZIP)} MB), ${mb(size.brotli)} MB brotli, ${size.seconds} s`,
);
if (gzipped > BUDGET_GZIP) {
  console.error(`wasm:build: over the size budget by ${gzipped - BUDGET_GZIP} bytes gzipped`);
  process.exit(1);
}
