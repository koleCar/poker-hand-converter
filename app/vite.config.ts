import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri sets TAURI_ENV_* for `tauri dev` / `tauri build`
// (https://v2.tauri.app/start/frontend/vite/).
const platform = process.env.TAURI_ENV_PLATFORM;
const debug = Boolean(process.env.TAURI_ENV_DEBUG);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@rail/ui` (packages/ui, R2.6) is linked source outside this folder:
    // one React for the app and the package.
    dedupe: ["react", "react-dom"],
    // (R5.4) The web's analysis library, used in place: `src/analysis/
    // library.ts` is the only door (ESLint keeps every other file away).
    alias: {
      "@rail/web-lib": fileURLToPath(new URL("../frontend/src/lib", import.meta.url)),
      // The web's files it brings in import `@rail/ui` as well: resolved to
      // this app's own link, not next to the web (not installed here).
      "@rail/ui": fileURLToPath(new URL("./node_modules/@rail/ui", import.meta.url)),
    },
  },
  // (R5.4) The analysis worker loads each preflop chart set as its own chunk
  // when a hand first needs it: a module worker, so it can split.
  worker: { format: "es" },
  // Tauri prints its own output; keep Rust errors on screen.
  clearScreen: false,
  server: {
    // `devUrl` in src-tauri/tauri.conf.json.
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    // The shared UI package (packages/ui) and the web's pure library it
    // builds on (frontend/src/lib) are outside this folder.
    fs: { allow: [".."] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 on Windows is evergreen Chromium; WKWebView on macOS is the
    // system WebKit (macOS 11+, `minimumSystemVersion`).
    target: platform === "windows" ? "chrome110" : "safari15",
    minify: debug ? false : "esbuild",
    sourcemap: debug,
  },
});
