// learn: the course map, one lesson (its goals, a checkpoint, the rules of
// thumb, the practice), the placement test and the review queue.

import type { Browser } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('learn');
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page, '/learn');
  await page.getByRole('heading', { name: 'Learn', exact: true }).waitFor();
  await settle(page, 1500);
  const lessons = page.locator('a[href^="/learn/"]:not([href*="placement"]):not([href*="review"]):not([href*="reference"])');
  await rec.shot(
    page,
    'map',
    {
      tab: page.getByRole('tab', { name: 'Learn' }),
      heading: page.getByRole('heading', { name: 'Learn', exact: true }),
      placement: page.getByRole('link', { name: /Placement test/ }).or(page.getByRole('button', { name: /Placement test/ })).first(),
      review: page.getByRole('link', { name: /^Review/ }).first(),
      preflop: page.getByRole('heading', { name: 'Preflop', exact: true }),
      firstLesson: lessons.first(),
      flop: page.getByRole('heading', { name: 'The flop', exact: true }),
    },
    { fullPage: true, maxHeight: 2400 },
  );

  const href = await lessons.first().getAttribute('href');
  await open(page, href!);
  await settle(page, 1500);
  await rec.shot(
    page,
    'lesson',
    {
      title: page.locator('h1').first(),
      goals: page.getByRole('heading', { name: 'In this lesson' }),
      checkpoint: page.getByRole('group', { name: 'Pick an answer, then see why.' }).first(),
      rules: page.getByRole('heading', { name: 'Rules of thumb' }),
      practice: page.getByRole('heading', { name: 'Practice' }),
      pager: page.getByRole('navigation', { name: 'Back to the course' }),
    },
    { fullPage: true, maxHeight: 9000 },
  );

  // A checkpoint: pick an answer, then see why.
  const checkpoint = page.getByRole('group', { name: 'Pick an answer, then see why.' }).first();
  await checkpoint.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -200));
  await checkpoint.getByRole('button').first().click();
  await settle(page, 1000);
  await rec.shot(page, 'checkpoint', { checkpoint: checkpoint.locator('xpath=ancestor::aside[1]'), choice: checkpoint.getByRole('button').first() });

  // Practice: the first exercise.
  const start = page.getByRole('button', { name: 'Start' }).first();
  await start.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -160));
  await start.click();
  await settle(page, 2000);
  await page.getByText(/^Exercise 1/).first().evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -130));
  await settle(page, 600);
  await rec.shot(page, 'exercise', {
    exercise: page.getByText(/^Exercise 1/).first(),
    question: page.getByText('What do you do?').first(),
  });

  await open(page, '/learn/placement');
  await settle(page, 1200);
  await rec.shot(page, 'placement', {
    heading: page.locator('h1').first(),
    take: page.getByRole('button', { name: /^Take the test/ }).first(),
  });
  await open(page, '/learn/review');
  await settle(page, 1200);
  await rec.shot(page, 'review', {
    heading: page.getByRole('heading', { name: 'Review', exact: true }),
    daily: page.getByText("Today's five minutes").first(),
  });
  await context.close();
  rec.save();
}
