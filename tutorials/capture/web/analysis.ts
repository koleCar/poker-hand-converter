// analysis: the analysis overview of the demo library (run by
// `npm run demo-data`) - grades, coverage, flags, the three biggest leaks,
// the hands list - and one hand's analysis sheet.

import type { Browser } from 'playwright';

import { psql, userId } from '../lib/accounts.ts';
import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('analysis');
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await open(page, '/analysis');
  await page.getByRole('heading', { name: 'Grades', level: 3 }).waitFor();
  // Hands the demo-data run left (a few the page analyses by itself): done first.
  await page.waitForFunction(
    () => ![...document.querySelectorAll('[role=status]')].some((el) => /Analysing/.test(el.textContent ?? '')),
    undefined,
    { timeout: 30 * 60_000, polling: 2000 },
  );
  await settle(page, 2500);
  const card = (title: string) => page.locator('section', { has: page.getByRole('heading', { name: title, exact: true, level: 3 }) }).first();
  await rec.shot(page, 'top', {
    tab: page.getByRole('tab', { name: 'Analysis' }),
    heading: page.getByRole('heading', { name: 'Analysis', exact: true }),
    subnav: page.getByRole('navigation', { name: 'Analysis sections' }),
    filters: page.getByRole('group', { name: 'Filter the analysed hands' }),
    grades: card('Grades'),
    analyse: page.getByLabel('Analyse').or(page.getByRole('button', { name: /^(Run analysis|Analyse new hands)$/ })).first(),
  });
  await rec.shot(
    page,
    'page',
    {
      grades: card('Grades'),
      coverage: card('Coverage'),
      flags: card('Flags'),
      street: card('By street'),
      leaks: card('Your three biggest leaks'),
      firstLeak: card('Your three biggest leaks').locator('li').first(),
      drills: card('Drills'),
      changed: card('What changed'),
      breakdown: card('Breakdown'),
      hands: 'section#analysis-hands',
      firstHand: page.locator('section#analysis-hands').getByRole('link', { name: /^Open the analysis of/ }).first(),
    },
    { fullPage: true },
  );

  // One hand: the replayer with its analysis sheet.
  // A river decision graded a Mistake: the sheet has the most to say.
  const hand = psql(`
    select hand_id from public.decision_analysis
    where owner_id = '${userId('demo')}' and street = 'river' and grade = 'mistake'
    order by ev_loss_bb desc nulls last limit 1;`);
  await open(page, `/analysis/h/${hand}`);
  await page.locator('.rp').first().waitFor();
  await settle(page, 3000);
  const sheet = page.locator('.rp-ov--sheet, .ov').filter({ hasText: 'Your decisions' }).first();
  await rec.shot(
    page,
    'hand',
    {
      replayer: page.locator('.rp').first(),
      sheet,
      decisions: sheet.getByText('Your decisions').first(),
      back: page.getByRole('link', { name: /^← Back to/ }).first(),
    },
    { fullPage: true },
  );
  await context.close();
  rec.save();
}
