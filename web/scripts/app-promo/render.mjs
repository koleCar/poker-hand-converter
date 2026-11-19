// Renders promo.html to web/public/download/, two pictures per language, at
// 2x (2400 x 1260) for sharp text; both are shown at 1200 x 630:
//
//   rail-app.<lang>.webp/.png    ?view=page, the picture on /download (WebP,
//                                with the PNG as the <img> fallback)
//   rail-app-promo.<lang>.png    ?view=card, the share card (Open Graph)
//
// WebP needs cwebp (`brew install webp`).
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
const shots = [
  { view: "page", name: "rail-app", webp: true },
  { view: "card", name: "rail-app-promo", webp: false },
];

for (const lang of ["en", "hr"]) {
  for (const shot of shots) {
    const file = join(out, `${shot.name}.${lang}.png`);
    execFileSync(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "--force-device-scale-factor=2",
      "--window-size=1200,630",
      "--virtual-time-budget=2000",
      `--screenshot=${file}`,
      `${page}?lang=${lang}&view=${shot.view}`,
    ], { stdio: "ignore" });
    const done = [file];
    if (shot.webp) {
      const webp = file.replace(/\.png$/, ".webp");
      execFileSync(process.env.CWEBP ?? "cwebp", ["-quiet", "-q", "86", file, "-o", webp]);
      done.push(webp);
    }
    for (const f of done) {
      console.log(`${f} (${Math.round(statSync(f).size / 1024)} KiB)`);
    }
  }
}
