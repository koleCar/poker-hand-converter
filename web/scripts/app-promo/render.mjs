// Renders promo.html to web/public/download/rail-app-promo.<lang>.png, one
// picture per language, at 2x (2400 x 1260) for sharp text on the /download
// page; the page and the share card show it at 1200 x 630. The page shows a
// WebP copy (cwebp, `brew install webp`); the PNG is the share card's.
//
//   node scripts/app-promo/render.mjs            (from web/)
//   CHROME=/path/to/chrome node scripts/app-promo/render.mjs
//
// Headless Chrome's own --screenshot, so nothing to install: any Chrome or
// Chromium build will do (default: Google Chrome in /Applications).

import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "public", "download");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const page = pathToFileURL(join(here, "promo.html")).href;

mkdirSync(out, { recursive: true });
for (const lang of ["en", "hr"]) {
  const file = join(out, `rail-app-promo.${lang}.png`);
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=2",
    "--window-size=1200,630",
    "--virtual-time-budget=2000",
    `--screenshot=${file}`,
    `${page}?lang=${lang}`,
  ], { stdio: "ignore" });
  const webp = file.replace(/\.png$/, ".webp");
  execFileSync(process.env.CWEBP ?? "cwebp", ["-quiet", "-q", "86", file, "-o", webp]);
  for (const done of [file, webp]) {
    console.log(`${done} (${Math.round(statSync(done).size / 1024)} KiB)`);
  }
}
