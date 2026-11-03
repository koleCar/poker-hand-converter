// The HUD process as the app's Tauri sidecar (docs/RAIL-PLAN.md R3.2).
//
// Builds `rail-hud` (release, the workspace's Cargo.lock) and copies it to
// where the bundler looks for `bundle.externalBin` "binaries/rail-hud":
// app/src-tauri/binaries/rail-hud-<target triple>[.exe]. The bundler puts
// it next to the app's executable (Rail.app/Contents/MacOS/rail-hud,
// beside Rail.exe), which is where the app starts it from.
//
//   npm run hud:sidecar
//   npm run tauri -- build --config src-tauri/tauri.hud.conf.json
//
// For another target, the same `--target` as `tauri build` gets:
//
//   npm run hud:sidecar -- --target universal-apple-darwin
//   npm run tauri -- build --target universal-apple-darwin --config src-tauri/tauri.hud.conf.json
//
// `universal-apple-darwin` (the release workflow's macOS build) is both Mac
// architectures, built one by one and joined with `lipo`, which is the file
// Tauri's universal bundle looks for.
//
// The extra config is kept out of tauri.conf.json on purpose: with
// externalBin there, every `cargo build -p rail-app` (clippy, tests, dev)
// would fail until the sidecar had been built and copied.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(app);

const targetFlag = process.argv.indexOf("--target");
const target = targetFlag === -1 ? null : process.argv[targetFlag + 1];
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)$/m)?.[1];
if (!host) {
  throw new Error("rustc -vV did not name the host triple");
}
const exe = (target ?? host).includes("windows") ? ".exe" : "";

/** Builds rail-hud for one triple (null: the host) and returns where it landed. */
function build(triple) {
  execFileSync("cargo", ["build", "--release", "--locked", "-p", "rail-hud", ...(triple ? ["--target", triple] : [])], {
    cwd: root,
    stdio: "inherit",
  });
  return join(root, "target", ...(triple ? [triple] : []), "release", `rail-hud${exe}`);
}

const to = join(app, "src-tauri", "binaries", `rail-hud-${target ?? host}${exe}`);
mkdirSync(dirname(to), { recursive: true });
if (target === "universal-apple-darwin") {
  const slices = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map(build);
  execFileSync("lipo", ["-create", "-output", to, ...slices], { stdio: "inherit" });
} else {
  copyFileSync(build(target), to);
}
console.log(`HUD sidecar: ${to}`);
