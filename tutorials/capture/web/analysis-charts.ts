// analysis-charts: Rail's preflop charts, a chart set of your own, and the
// trainer.

import type { Browser } from 'playwright';

import { psql, userId } from '../lib/accounts.ts';
import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('analysis-charts');
  // A clean start: no chart set of the demo account's yet (a rerun made one).
  psql(`delete from public.preflop_chart_sets where owner_id = '${userId('demo')}';`);
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await open(page, '/analysis/charts');
  const grid = page.getByRole('grid').first();
  await grid.waitFor();
  await settle(page, 1500);
  const cell = grid.getByRole('button', { name: /^AKo:/ }).or(grid.getByRole('gridcell', { name: /^AKo:/ })).first();
  await cell.hover();
  await settle(page, 800);
  await rec.shot(
    page,
    'charts',
    {
      table: page.getByLabel('Table and depth'),
      scenario: page.getByLabel('Scenario'),
      spot: page.getByLabel('Spot'),
      legend: page.locator('ul[aria-label="Actions"]'),
      grid,
      cell,
    },
    { fullPage: true, maxHeight: 2400 },
  );

  await open(page, '/analysis/my-charts');
  await settle(page, 2000);
  const create = page.getByRole('button', { name: /New chart set/ });
  if (await create.isVisible().catch(() => false)) {
    await create.click();
    await settle(page, 2000);
  }
  // Start the open-from-UTG situation from Rail's own chart.
  const fromRail = page.locator('details', { has: page.locator('summary', { hasText: "Start from Rail's chart" }) });
  await fromRail.locator('summary').click();
  await fromRail.getByRole('button', { name: 'Copy' }).click();
  await settle(page, 1500);
  await rec.shot(
    page,
    'my-charts',
    {
      tabs: page.getByRole('tab', { name: 'Edit' }),
      compare: page.getByRole('tab', { name: /Compare/ }),
      grid: page.getByRole('grid').first(),
      brush: page.getByRole('button', { name: 'Raise 100 %' }).first(),
      fromRail: fromRail.locator('summary'),
      save: page.getByRole('button', { name: 'Save', exact: true }),
    },
    { fullPage: true, maxHeight: 2600 },
  );

  await open(page, '/analysis/train');
  await settle(page, 3000);
  const options = page.getByRole('group', { name: 'Your options' });
  await options.waitFor();
  await rec.shot(
    page,
    'train',
    {
      what: page.getByRole('navigation', { name: 'What to practise' }),
      options,
      session: page.getByText('This session').first(),
    },
    { fullPage: true, maxHeight: 2400 },
  );
  await options.getByRole('button').first().click();
  await settle(page, 1500);
  await rec.shot(
    page,
    'train-answer',
    {
      options,
      next: page.getByRole('button', { name: 'Next spot' }),
    },
    { fullPage: true },
  );
  await context.close();
  rec.save();
}
