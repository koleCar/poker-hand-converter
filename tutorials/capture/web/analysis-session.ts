// analysis-session: the review of the demo library's latest finished
// session, and one decision from it opened in its analysis.

import type { Browser } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('analysis-session');
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await open(page, '/analysis/session');
  const summary = page.locator('section[aria-label="Session summary"]');
  await summary.waitFor();
  await settle(page, 2500);
  const list = (title: string) => page.locator('section', { has: page.getByRole('heading', { name: title, level: 2 }) }).first();
  await rec.shot(
    page,
    'review',
    {
      subnav: page.getByRole('navigation', { name: 'Analysis sections' }),
      picker: page.locator('select', { has: page.getByRole('option', { name: 'Latest finished session' }) }),
      previous: page.getByRole('button', { name: /Previous session/ }),
      summary,
      worst: list('Worst decisions'),
      firstWorst: list('Worst decisions').getByRole('link').first(),
      charts: list('Off your preflop charts'),
      pots: list('Biggest pots'),
    },
    { fullPage: true },
  );

  await page.locator('select', { has: page.getByRole('option', { name: 'Latest finished session' }) }).focus();
  await rec.shot(page, 'picker', { picker: page.locator('select', { has: page.getByRole('option', { name: 'Latest finished session' }) }), summary });

  await list('Worst decisions').getByRole('link').first().click();
  await page.waitForURL(/\/analysis\/h\//);
  await page.locator('.rp').first().waitFor();
  await settle(page, 3000);
  await rec.shot(
    page,
    'decision',
    {
      replayer: page.locator('.rp').first(),
      sheet: page.locator('.ov').filter({ hasText: 'Your decisions' }).first(),
      back: page.getByRole('link', { name: /^← Back to/ }).first(),
    },
    { fullPage: true },
  );
  await context.close();
  rec.save();
}
