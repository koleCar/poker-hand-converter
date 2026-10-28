// stats: the statistics page over the demo library - the summary, the
// win-rate graph, every statistic, a filter, the breakdowns with the
// starting-hand grid, and the sessions.

import type { Browser, Page } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

async function scrollTo(page: Page, selector: string) {
  await page.locator(selector).first().scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await settle(page, 700);
}

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('stats');
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page, '/stats');
  await page.waitForFunction(() => !document.querySelector('.stats-coverage'), undefined, { timeout: 15 * 60_000 });
  await page.locator('section[aria-label="Summary"]').waitFor();
  await settle(page, 2000);
  await rec.shot(page, 'top', {
    tab: page.getByRole('tab', { name: 'Statistics' }),
    subnav: page.getByRole('navigation', { name: 'Statistics' }),
    filters: page.getByRole('toolbar', { name: 'Filters' }),
    summary: 'section[aria-label="Summary"]',
    hud: '.stats-hud',
  });

  await scrollTo(page, '#reports-graph');
  await rec.shot(page, 'graph', {
    graph: page.locator('section', { has: page.locator('#reports-graph') }),
    unit: page.getByRole('group', { name: 'Show in' }),
    chart: page.getByRole('img', { name: /^Cumulative win rate/ }),
  });
  await page.getByRole('group', { name: 'Show in' }).getByRole('button', { name: 'Money' }).click();
  await settle(page, 1000);
  await rec.shot(page, 'graph-money', {
    graph: page.locator('section', { has: page.locator('#reports-graph') }),
    money: page.getByRole('group', { name: 'Show in' }).getByRole('button', { name: 'Money' }),
  });

  await scrollTo(page, '#reports-stats');
  await rec.shot(page, 'statistics', {
    heading: '#reports-stats',
    tables: page.locator('section', { has: page.locator('#reports-stats') }),
  });

  await scrollTo(page, 'h2:text-is("Breakdown")');
  const tabs = page.getByRole('tablist', { name: 'Split by' });
  await rec.shot(page, 'breakdown', { tabs, card: page.locator('section', { has: tabs }) });
  await tabs.getByRole('tab', { name: 'Starting hands' }).click();
  await page.getByRole('grid', { name: /Starting hands/ }).waitFor();
  await settle(page, 1200);
  await page.getByRole('grid', { name: /Starting hands/ }).scrollIntoViewIfNeeded();
  await settle(page, 600);
  const grid = page.getByRole('grid', { name: /Starting hands/ });
  await rec.shot(page, 'grid', {
    grid,
    colourBy: page.getByRole('group', { name: 'Colour by' }),
    aks: grid.getByRole('gridcell', { name: /^AKs:/ }),
  });
  await grid.getByRole('gridcell', { name: /^AKs:/ }).click();
  await settle(page, 800);
  await rec.shot(page, 'grid-cell', {
    grid,
    aks: grid.getByRole('gridcell', { name: /^AKs:/ }),
    detail: page.getByRole('status').filter({ hasText: 'AKs in this sample' }),
  }, { fullPage: true, maxHeight: 3800 });
  // Back to the short Position table before the sessions below it.
  await tabs.getByRole('tab', { name: 'Position' }).click();
  await settle(page, 800);

  await scrollTo(page, 'h3:text-is("Sessions")');
  await rec.shot(page, 'sessions', {
    card: page.locator('section', { has: page.locator('h3:text-is("Sessions")') }),
    bankroll: page.getByRole('img', { name: /^Bankroll/ }),
    breakSelect: page.getByLabel('A break longer than'),
    review: page.getByRole('link', { name: /^Review the session/ }).first(),
  }, { fullPage: true });

  // A filter: the date chip narrows everything on the page.
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle(page, 400);
  const toolbar = page.getByRole('toolbar', { name: 'Filters' });
  await toolbar.getByRole('button', { name: /^(Filter: )?Stakes/ }).click();
  const popover = page.getByRole('dialog', { name: 'Stakes' });
  await popover.waitFor();
  await settle(page, 600);
  await rec.shot(page, 'filter', { chip: toolbar.getByRole('button', { name: /^(Filter: )?Stakes/ }), popover });
  await context.close();
  rec.save();
}
