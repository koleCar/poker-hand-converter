// The "no visual change" check of R2.6 (docs/RAIL-PLAN.md), kept so the next
// move between the web and packages/ui can rerun it.
//
// Two builds of the web, offline (no Supabase env, so the app runs as the
// offline converter), each served by `next start`: the base (a checkout of the
// branch point) and the change. Capture each twice, then compare:
//
//   cd packages/ui/screens && npm ci && npx playwright install chromium
//   node screens.mjs capture http://localhost:3100 out/base-1
//   node screens.mjs capture http://localhost:3200 out/change-1
//   node screens.mjs capture http://localhost:3100 out/base-2
//   node screens.mjs capture http://localhost:3200 out/change-2
//   node screens.mjs compare out/base-1,out/base-2 out/change-1,out/change-2
//
// Per screen it writes the screenshot, the page's whole cascade (every CSS
// rule in document order) and its DOM. A screenshot counts as unchanged when
// any run of one build equals any run of the other pixel for pixel: the sticky
// header's backdrop blur over the replayer makes a handful of full-page
// screenshots differ by a few dozen pixels between two runs of the same build,
// and the second run is what tells that noise from a change. Nothing here is
// committed output; `out/` is ignored.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CORPUS = join(REPOSITORY, "fixtures/samples/pokerstars/27-cash-multi-hand-file-blank-line-separator.txt");
const RUN_IT_TWICE = join(REPOSITORY, "fixtures/samples/pokerstars/03-cash-plo-run-it-twice-sidepot-dualtimestamp.txt");
// Around the replayer's container-query breakpoints (30rem stage; 32rem and
// 22rem felt), at two heights below 768, where the felt is height-bound.
const WIDTHS = [1440, 1100, 900, 768, 600, 480, 390, 320];
const PAGES = [
  ["convert-empty", "/convert"],
  ["stats-signed-out", "/stats"],
  ["library-signed-out", "/library"],
  ["home", "/"],
  ["upload", "/upload"],
  ["manual", "/convert/manual"],
  ["shared-hand-offline", "/h/abc123"],
  ["learn", "/learn"],
  ["analysis", "/analysis"],
];

async function capture(base, out) {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  let shots = 0;

  async function open(width, height, theme) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      colorScheme: theme,
      locale: "en-GB",
      timezoneId: "Europe/Zagreb",
    });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem("rail.theme", t);
      } catch {
        // The theme falls back to the colour scheme.
      }
    }, theme);
    return { context, page: await context.newPage() };
  }

  async function settle(page) {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  }

  async function shot(page, name, fullPage = true) {
    await settle(page);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage, animations: "disabled", caret: "hide" });
    shots++;
    const { css, html } = await page.evaluate(() => {
      const css = [...document.styleSheets]
        .map((sheet) => {
          try {
            return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
          } catch {
            return `/* unreadable ${sheet.href} */`;
          }
        })
        .join("\n/* ---- sheet ---- */\n");
      const body = document.body.cloneNode(true);
      body.querySelectorAll("script, next-route-announcer").forEach((node) => node.remove());
      return { css, html: body.innerHTML };
    });
    writeFileSync(join(out, `${name}.css.txt`), css);
    writeFileSync(join(out, `${name}.html.txt`), html);
  }

  async function element(page, name) {
    await settle(page);
    await page.locator(".rp").first().screenshot({ path: join(out, `${name}.png`), animations: "disabled" });
  }

  async function convert(page, file) {
    await page.goto(`${base}/convert`);
    await settle(page);
    await page.locator('input[type="file"][multiple]:not([webkitdirectory])').first().setInputFiles(file);
    await page.getByRole("button", { name: /^Replay$/ }).first().waitFor({ timeout: 60000 });
  }

  for (const theme of ["dark", "light"]) {
    for (const [name, path] of PAGES) {
      for (const width of [1280, 390]) {
        const { context, page } = await open(width, 900, theme);
        await page.goto(`${base}${path}`);
        await shot(page, `${theme}-${name}-${width}`);
        await context.close();
      }
    }

    // The converter's output for a dropped file.
    for (const width of [1280, 390]) {
      const { context, page } = await open(width, 900, theme);
      await convert(page, CORPUS);
      await shot(page, `${theme}-convert-output-${width}`);
      await context.close();
    }

    // The single-hand replayer inline on /convert.
    for (const width of [1280, 600, 390]) {
      const { context, page } = await open(width, 900, theme);
      await page.goto(`${base}/convert`);
      await settle(page);
      await page.locator('input[type="file"]').first().setInputFiles(RUN_IT_TWICE);
      await page.locator(".rp").first().waitFor({ timeout: 60000 });
      await page.getByRole("button", { name: "Jump to end" }).first().click();
      await shot(page, `${theme}-convert-inline-replayer-${width}`);
      await context.close();
    }

    // The replayer in the library, opened from the converter: start, six
    // actions in (bets in front of the seats), the end (board, pot, showdown).
    for (const [label, file] of [["stars", CORPUS], ["rit", RUN_IT_TWICE]]) {
      for (const width of WIDTHS) {
        for (const height of width >= 768 ? [900] : [800, 560]) {
          const id = `${theme}-replayer-${label}-${width}x${height}`;
          const { context, page } = await open(width, height, theme);
          await convert(page, file);
          await page.getByRole("button", { name: /^Replay$/ }).first().click();
          await page.waitForURL(/\/library/);
          await page.locator(".rp").first().waitFor({ timeout: 60000 });
          await shot(page, `${id}-start`);
          const next = page.getByRole("button", { name: "Next action" }).first();
          for (let i = 0; i < 6; i++) await next.click();
          await shot(page, `${id}-step6`);
          await element(page, `${id}-step6-rp`);
          await page.getByRole("button", { name: "Jump to end" }).first().click();
          await shot(page, `${id}-end`);
          await element(page, `${id}-end-rp`);
          await context.close();
        }
      }
    }
  }

  // Two of the replayer's sheets.
  {
    const { context, page } = await open(1280, 900, "dark");
    await convert(page, RUN_IT_TWICE);
    await page.getByRole("button", { name: /^Replay$/ }).first().click();
    await page.locator(".rp").first().waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Jump to end" }).first().click();
    // The end opens the result sheet; close it first.
    await page.locator("dialog.ov[open]").first().waitFor();
    await page.keyboard.press("Escape");
    await page.locator("dialog.ov[open]").first().waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Hand info" }).first().click();
    await page.locator("dialog.ov[open]").first().waitFor();
    await shot(page, "dark-replayer-info-sheet", false);
    await page.keyboard.press("Escape");
    await page.locator("dialog.ov[open]").first().waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Hand info" }).first().focus();
    await page.keyboard.press("Shift+Slash");
    await page.locator("dialog.ov[open]").first().waitFor();
    await shot(page, "dark-replayer-shortcuts", false);
    await context.close();
  }

  await browser.close();
  console.log(`${shots} full captures in ${out}`);
}

function pixels(a, b) {
  if (!existsSync(a) || !existsSync(b)) return Infinity;
  const A = PNG.sync.read(readFileSync(a));
  const B = PNG.sync.read(readFileSync(b));
  if (A.width !== B.width || A.height !== B.height) return Infinity;
  return pixelmatch(A.data, B.data, null, A.width, A.height, { threshold: 0 });
}

function text(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function compare(baseRuns, changeRuns) {
  const names = readdirSync(baseRuns[0]).sort();
  const changed = [];
  let same = 0;
  for (const name of names.filter((n) => n.endsWith(".png"))) {
    let best = Infinity;
    for (const a of baseRuns) for (const b of changeRuns) best = Math.min(best, pixels(join(a, name), join(b, name)));
    if (best === 0) same++;
    else changed.push(`${name}: ${best === Infinity ? "missing or resized" : `at best ${best} px differ`}`);
  }
  const dumps = names.filter((n) => n.endsWith(".txt"));
  let sameText = 0;
  for (const name of dumps) {
    const equal = baseRuns.some((a) => changeRuns.some((b) => text(join(a, name)) === text(join(b, name))));
    if (equal) sameText++;
    else changed.push(`${name}: differs`);
  }
  console.log(`${names.filter((n) => n.endsWith(".png")).length} screenshots: ${same} identical`);
  console.log(`${dumps.length} cascade and DOM dumps: ${sameText} identical`);
  for (const line of changed) console.log(`  ${line}`);
  process.exitCode = changed.length ? 1 : 0;
}

const [command, ...args] = process.argv.slice(2);
if (command === "capture" && args.length === 2) {
  await capture(args[0], args[1]);
} else if (command === "compare" && args.length === 2) {
  compare(args[0].split(","), args[1].split(","));
} else {
  console.error("usage: node screens.mjs capture <baseUrl> <outDir> | compare <base1,base2> <change1,change2>");
  process.exitCode = 2;
}
