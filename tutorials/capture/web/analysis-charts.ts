// analysis-charts: Rail's preflop charts and the trainer.

import type { Browser } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('analysis-charts');
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
