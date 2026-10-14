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
// The extra config is kept out of tauri.conf.json on purpose: with
// externalBin there, every `cargo build -p rail-app` (clippy, tests, dev)
// would fail until the sidecar had been built and copied.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(app);

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (\S+)$/m)?.[1];
if (!host) {
  throw new Error("rustc -vV did not name the host triple");
}
const exe = process.platform === "win32" ? ".exe" : "";

execFileSync("cargo", ["build", "--release", "--locked", "-p", "rail-hud"], {
  cwd: root,
  stdio: "inherit",
});

const from = join(root, "target", "release", `rail-hud${exe}`);
const to = join(app, "src-tauri", "binaries", `rail-hud-${host}${exe}`);
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`HUD sidecar: ${to}`);
