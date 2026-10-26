// The phone check of R4.5 (docs/RAIL-PLAN.md R4.5b, R4.5d): the web's Hands,
// Reports (`/stats`, the opponents panel in it), Players (`/players`, R4.5c),
// the session review (`/analysis/session`, R5.1), the overview's three
// biggest leaks (`/analysis`, R5.2), your own charts (`/analysis/my-charts`,
// R5.3: the list, a set's editor and its tools, the comparison, a hand opened
// from it), a shared hand and its
// embed, a tournament hand's push/fold panel and its settings form (R5.5,
// `RAIL_CHECK_ICM=<hand id>:<action index>` - a decision the push/fold game
// graded), and the replayer, at 375 x 812 as a touch phone (coarse pointer), in
// English and Croatian, against a running web - a local `next start` over a
// local Supabase stack with a signed-in test account:
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
const ICM = process.env.RAIL_CHECK_ICM ?? "";
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
 * - the starting-hand grid's 169 cells (`[role=gridcell]`, the shared Reports
 *   screen's since R4.5c; `.stats-matrix__cell` the web's own grid before):
 *   13 across a phone is 22 px each; every class is also a row of the table
 *   under the grid, which is the touch path; R5.3's chart grids are the same
 *   (the editor's touch path is the rank list under the grid, 44 px buttons;
 *   the comparison's, its list of deviations);
 * - a checkbox or radio inside a label: the label is the target (checked
 *   for 44 px separately when it is a toggle row);
 * - a link inside running text;
 * - the replayer's rail pips (`.rp__mark`, 14 px on the scrub bar of a hand's
 *   analysis): every pip is also a decision chip in the Analysis sheet beside
 *   it, which is the touch path (R5.1 opens hands there).
 */
const EXCEPTIONS = ["[role=gridcell]", ".stats-matrix__cell", "label input", "p a", "li a", "small a", ".rp__mark"];

/**
 * The page's sideways scroll, and the small controls inside `root` (`main`;
 * a part of a page names its own box - the overview's top three, R5.2,
 * whose page around it is not this check's yet).
 */
async function audit(page, root = "main") {
  return page.evaluate(([exceptions, scope]) => {
    const doc = document.documentElement;
    const sideways = doc.scrollWidth > doc.clientWidth;
    const controls = [
      ...document.querySelectorAll(
        [
          "button",
          "select",
          "input",
          "textarea",
          "a.btn",
          "[role=slider]",
          "[role=tab]",
          "summary",
          "[role=row][tabindex]",
          "label:has(> input[type=checkbox])",
        ]
          .map((control) => `${scope} ${control}`)
          .join(", "),
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
  }, [EXCEPTIONS, root]);
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

  const report = async (label, root = "main") => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(800);
    const result = await audit(page, root);
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

  // Reports (the shared screen since R4.5c): the screen, each breakdown tab
  // (the starting hands' grid among them) and every filter panel.
  await page.goto(`${BASE}/stats`);
  await page.locator("main button[role=tab][aria-controls]").first().waitFor({ timeout: 60000 });
  await report("/stats");
  const statsChips = page.getByRole("toolbar").locator("button[aria-haspopup=dialog]");
  for (let i = 0; i < (await statsChips.count()); i++) {
    await statsChips.nth(i).click();
    await page.locator("div[role=dialog]").last().waitFor();
    const box = await page.locator("div[role=dialog]").last().boundingBox();
    if (!box || box.x < 0 || box.x + box.width > 375.5) {
      failures++;
      console.log(`NOT OK - ${locale} /stats filter panel ${i} is outside the screen`);
    }
    await page.keyboard.press("Escape");
  }
  console.log(`ok - ${locale} /stats: ${await statsChips.count()} filter panels inside the screen`);
  // The breakdown's tabs (they control a panel; the shell's own navigation does not).
  const tabs = page.locator("main button[role=tab][aria-controls]");
  for (let i = 0; i < (await tabs.count()); i++) {
    await tabs.nth(i).click();
    await report(`/stats, breakdown "${(await tabs.nth(i).innerText()).trim()}"`);
  }

  // Players (the shared screen since R4.5c): the opt-in when opponent
  // statistics are off in this browser (turned on here, which reads the
  // opponents of the hands stored), the list, a player open and each of the
  // profile's tabs.
  await page.goto(`${BASE}/players`);
  const playerRows = page.locator("main [role=row][data-key]");
  const optIn = page.locator("main .stats-empty .btn--primary");
  await Promise.race([playerRows.first().waitFor({ timeout: 60000 }), optIn.waitFor({ timeout: 60000 })]);
  if (await optIn.isVisible()) {
    await report("/players, opponent statistics off");
    await optIn.click();
  }
  await playerRows.first().waitFor({ timeout: 180000 });
  await report("/players");
  await playerRows.first().click();
  await page.locator("main section[aria-labelledby]").first().waitFor({ timeout: 30000 });
  await page.locator("main section[aria-labelledby] [role=tabpanel]").first().waitFor({ timeout: 30000 });
  await report("/players, a player open");
  const profileTabs = page.locator("main section[aria-labelledby] button[role=tab][aria-controls]");
  for (let i = 0; i < (await profileTabs.count()); i++) {
    await profileTabs.nth(i).click();
    await report(`/players, profile "${(await profileTabs.nth(i).innerText()).trim()}"`);
  }

  // The session review (R5.1): the latest finished session, the one before
  // it, and a hand opened from a list (its analysis, at the decision).
  await page.goto(`${BASE}/analysis/session`);
  await page.locator("main section[aria-label], main .stats-empty").first().waitFor({ timeout: 60000 });
  await report("/analysis/session");
  const previous = page.getByRole("button", { name: locale === "en" ? /Previous session/ : /Prethodna sesija/ });
  if ((await previous.count()) > 0 && (await previous.isEnabled())) {
    await previous.click();
    await page.waitForFunction(() => !document.querySelector("main [aria-busy=true]"), null, { timeout: 60000 });
    await report("/analysis/session, the session before");
  }
  const listed = page.locator("main ol a[href^='/analysis/h/']");
  if ((await listed.count()) > 0) {
    await listed.first().click();
    await page.locator(".rp").first().waitFor({ timeout: 60000 });
    await report("/analysis/h/<id> from the session review");
  }

  // The overview's three biggest leaks (R5.2): the card in each period, and a
  // hand opened from its examples (its analysis, at the decision). Only the
  // card's own controls are audited: the overview around it predates the check.
  await page.goto(`${BASE}/analysis`);
  const topCard = "main section[aria-labelledby=top-leaks]";
  await page.locator(topCard).waitFor({ timeout: 60000 });
  await page.waitForFunction((card) => !document.querySelector(`${card}[aria-busy=true]`), topCard, { timeout: 60000 });
  await report("/analysis, the three biggest leaks (30 days)", topCard);
  await page.locator(`${topCard} button[aria-pressed=false]`).first().click();
  await page.waitForFunction((card) => !document.querySelector(`${card}[aria-busy=true]`), topCard, { timeout: 60000 });
  await report("/analysis, the three biggest leaks (all time)", topCard);
  const example = page.locator(`${topCard} a[href^='/analysis/h/']`);
  if ((await example.count()) > 0) {
    await example.first().click();
    await page.locator(".rp").first().waitFor({ timeout: 60000 });
    await report("/analysis/h/<id> from the top three");
  }

  // Your own charts (R5.3): the list, the first set's editor with every tool
  // open, its comparison (all time) and a deviation's example hand opened at
  // the decision. The account needs a saved chart set for all but the first.
  await page.goto(`${BASE}/analysis/my-charts`);
  const library = "main section[aria-labelledby=charts-library]";
  await page.locator(library).waitFor({ timeout: 60000 });
  await report("/analysis/my-charts");
  const firstSet = page.locator(`${library} li button`).first();
  if ((await firstSet.count()) > 0) {
    await firstSet.click();
    await page.locator("main [role=grid]").first().waitFor({ timeout: 30000 });
    await report("/analysis/my-charts, a set's editor");
    for (const summary of await page.locator("main section details > summary").all()) await summary.click();
    await report("/analysis/my-charts, the editor's tools open");
    await page.locator("main [role=tablist] button[role=tab]").nth(1).click();
    const compare = "main section[aria-labelledby=charts-compare]";
    await page.locator(compare).waitFor({ timeout: 30000 });
    await page.locator(`${compare} button[aria-pressed]`).last().click();
    await page.waitForFunction((card) => !document.querySelector(`${card}[aria-busy=true]`), compare, { timeout: 60000 });
    await report("/analysis/my-charts, the comparison (all time)");
    const deviation = page.locator("main section[aria-labelledby=charts-detail] ul button").first();
    if ((await deviation.count()) > 0) {
      await deviation.click();
      const example = page.locator("main a[href^='/analysis/h/']").first();
      await example.waitFor({ timeout: 30000 }).catch(() => {});
      await report("/analysis/my-charts, a deviation's examples");
      if ((await example.count()) > 0) {
        await example.click();
        await page.locator(".rp").first().waitFor({ timeout: 60000 });
        await report("/analysis/h/<id> from your charts");
      }
    }
  }

  if (ICM) {
    // R5.5: the push/fold panel of a tournament decision, then its settings form open.
    const [handId, actionIndex] = ICM.split(":");
    await page.goto(`${BASE}/analysis/h/${handId}?t=a${actionIndex}`);
    await page.locator("main #icm-panel").waitFor({ timeout: 60000 });
    await report("/analysis/h/<id>, a push/fold decision");
    await page.locator("main #icm-panel button[aria-expanded]").click();
    await page.locator("main #icm-panel form").waitFor({ timeout: 30000 });
    await report("/analysis/h/<id>, the tournament's settings open", "main #icm-panel");
  }

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
