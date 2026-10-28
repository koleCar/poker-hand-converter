// analysis-leaks: the leak report of the demo library, one leak opened,
// this week's plan built from them, and progress over time.

import type { Browser } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('analysis-leaks');
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await open(page, '/analysis/leaks');
  const leaksHeading = page.locator('#leaks-list');
  await leaksHeading.waitFor();
  await settle(page, 2500);
  const leakList = page.locator('ol', { has: page.locator('button[aria-expanded]') }).first();
  await rec.shot(
    page,
    'report',
    {
      subnav: page.getByRole('navigation', { name: 'Analysis sections' }),
      filters: page.getByRole('group', { name: 'Report filters' }),
      heading: leaksHeading,
      list: leakList,
      first: leakList.locator('button[aria-expanded]').first(),
    },
    { fullPage: true, maxHeight: 2600 },
  );

  await leakList.locator('button[aria-expanded]').first().click();
  await settle(page, 1500);
  const item = leakList.locator('li').first();
  await rec.shot(
    page,
    'leak',
    {
      item,
      drill: item.getByRole('link', { name: /Drill this/ }),
      hands: item.getByText('Your hands in this spot').first(),
    },
    { fullPage: true, maxHeight: 4000 },
  );

  await open(page, '/analysis/plan');
  await settle(page, 3000);
  await rec.shot(
    page,
    'plan',
    {
      heading: page.getByText(/^Week of/).first(),
      progress: page.getByRole('progressbar').first(),
      focus: page.getByText("This week's focus").first(),
    },
    { fullPage: true, maxHeight: 3000 },
  );

  await open(page, '/analysis/progress');
  await settle(page, 3000);
  await rec.shot(
    page,
    'progress',
    {
      groupBy: page.getByRole('group', { name: 'Group by' }),
      score: page.getByRole('group', { name: /^Score, / }),
      ev: page.getByRole('group', { name: /^EV lost per 100 hands, / }),
    },
    { fullPage: true, maxHeight: 3000 },
  );
  await context.close();
  rec.save();
}
