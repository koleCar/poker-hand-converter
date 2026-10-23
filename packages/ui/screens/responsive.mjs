// The phone check of R4.5 (docs/RAIL-PLAN.md R4.5b, R4.5d): the web's Hands,
// Reports (`/stats`, the opponents panel in it), a shared hand and its embed,
// and the replayer, at 375 x 812 as a touch phone (coarse pointer), in English
// and Croatian, against a running web - a local `next start` over a local
// Supabase stack with a signed-in test account:
//
//   RAIL_CHECK_EMAIL=... RAIL_CHECK_PASSWORD=... RAIL_CHECK_SHARE=<slug> \
//   node responsive.mjs http://localhost:3145
//
// For each page and language it reports whether the page scrolls sideways
// (it must not: anything wider scrolls inside its own box), and every
// control - button, link styled as a button, chip, field, the replayer's
// slider - smaller than 44 x 44 px, except what is listed in EXCEPTIONS (a
// dense grid whose cells are each reachable another way). Exits non-zero when
// a page scrolls sideways or an unexcepted control is too small. Local only:
// it signs in with the account given.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

mkdirSync("out", { recursive: true });

const BASE = process.argv[2];
const EMAIL = process.env.RAIL_CHECK_EMAIL ?? "";
const PASSWORD = process.env.RAIL_CHECK_PASSWORD ?? "";
const SHARE = process.env.RAIL_CHECK_SHARE ?? "";
if (!BASE || !EMAIL || !PASSWORD) {
  console.error("usage: RAIL_CHECK_EMAIL=... RAIL_CHECK_PASSWORD=... [RAIL_CHECK_SHARE=slug] node responsive.mjs <baseUrl>");
  process.exit(2);
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) {
  console.error("Refusing: this signs in with a test account, so it runs against a local web only.");
  process.exit(2);
}

/**
 * Controls that may be under 44 px, and why:
 * - the starting-hand grid's 169 cells (`.stats-matrix__cell`): 13 across a
 *   phone is 22 px each; every class is also a row of the table under the
 *   grid, which is the touch path;
 * - a checkbox or radio inside a label: the label is the target (checked
 *   for 44 px separately when it is a toggle row);
 * - a link inside running text.
 */
const EXCEPTIONS = [".stats-matrix__cell", "label input", "p a", "li a", "small a"];

async function audit(page) {
  return page.evaluate((exceptions) => {
    const doc = document.documentElement;
    const sideways = doc.scrollWidth > doc.clientWidth;
    const controls = [
      ...document.querySelectorAll(
        "main button, main select, main input, main textarea, main a.btn, main [role=slider], main [role=tab], main summary, main [role=row][tabindex], main label:has(> input[type=checkbox])",
      ),
    ];
    const small = [];
    for (const element of controls) {
      if (exceptions.some((selector) => element.matches(selector) || element.closest(selector) === element)) continue;
      if (element.matches("input[type=hidden], input[type=file]")) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden") continue;
      // A control inside a box that clips it away is not on screen.
      if (box.bottom < 0 || box.right < 0 || box.left > doc.clientWidth) continue;
      if (box.height < 43.5 || (box.width < 43.5 && !element.matches("input, select, textarea"))) {
        const name = (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 30);
        small.push(`${element.tagName.toLowerCase()}${element.className ? "." + String(element.className).split(" ")[0] : ""} ${Math.round(box.width)}x${Math.round(box.height)} "${name}"`);
      }
    }
    return { sideways, width: doc.scrollWidth, small: [...new Set(small)] };
  }, EXCEPTIONS);
}

const browser = await chromium.launch();
let failures = 0;

for (const locale of ["en", "hr"]) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: locale === "en" ? "en-GB" : "hr-HR",
  });
  await context.addCookies([{ name: "rail.locale", value: locale, url: BASE }]);
  const page = await context.newPage();

  // Sign in through the page, as a reader does.
  // Signed out, /library sends a reader without hands to the converter with
  // the sign-in dialog open; otherwise the bar's button opens it.
  await page.goto(`${BASE}/library`);
  await page.waitForTimeout(1500);
  const email = page.locator('input[type="email"]');
  if (!(await email.isVisible())) {
    await page.getByRole("button", { name: locale === "en" ? "Sign in" : "Prijava" }).first().click();
  }
  await email.fill(EMAIL);
  await page.locator('input[type="password"]').fill(PASSWORD);
  // The robot check (Turnstile's test key on a local stack) finishes on its
  // own; the dialog closes once the session is there.
  await page.waitForTimeout(4000);
  await page.locator('form button[type="submit"]').first().click();
  await email.waitFor({ state: "hidden", timeout: 30000 });

  const report = async (label) => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
    const result = await audit(page);
    const ok = !result.sideways && result.small.length === 0;
    if (!ok) failures++;
    console.log(`${ok ? "ok" : "NOT OK"} - ${locale} ${label}: ${result.sideways ? `scrolls sideways (${result.width}px)` : "no sideways scroll"}, ${result.small.length} small controls`);
    for (const line of result.small) console.log(`    ${line}`);
  };

  await page.goto(`${BASE}/library`);
  await page
    .locator("[role=row][data-key]")
    .first()
    .waitFor({ timeout: 30000 })
    .catch(async (error) => {
      // Signed in? Loaded? What the page shows says (`out/` is ignored).
      await page.screenshot({ path: "out/responsive-error.png", fullPage: true });
      throw error;
    });
  await report("/library, the list");
  await page.locator("[role=row][data-key]").first().click();
  await page.locator(".rp").first().waitFor({ timeout: 30000 });
  await report("/library, a hand open");
  // Every filter chip's panel opens and fits.
  const chips = page.getByRole("toolbar").locator("button[aria-haspopup=dialog]");
  for (let i = 0; i < (await chips.count()); i++) {
    await chips.nth(i).click();
    await page.locator("div[role=dialog]").last().waitFor();
    const box = await page.locator("div[role=dialog]").last().boundingBox();
    if (!box || box.x < 0 || box.x + box.width > 375.5) {
      failures++;
      console.log(`NOT OK - ${locale} /library filter panel ${i} is outside the screen`);
    }
    await page.keyboard.press("Escape");
  }
  console.log(`ok - ${locale} /library: ${await chips.count()} filter panels inside the screen`);

  await page.goto(`${BASE}/stats`);
  await page.locator(".stats-group").first().waitFor({ timeout: 60000 });
  await report("/stats");

  if (SHARE) {
    await page.goto(`${BASE}/h/${SHARE}`);
    await page.locator(".rp").first().waitFor({ timeout: 30000 });
    await report(`/h/${SHARE}`);
    await page.goto(`${BASE}/embed/h/${SHARE}`);
    await page.locator(".rp").first().waitFor({ timeout: 30000 });
    await report(`/embed/h/${SHARE}`);
  }
  await context.close();
}

await browser.close();
process.exitCode = failures ? 1 : 0;
