// library: the hand history - the list, filters as chips with their
// counts, the searches, the order, and a hand opening beside the list.

import type { Browser, Page } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

async function chip(page: Page, group: string) {
  const button = page.getByRole('toolbar', { name: 'Filters' }).getByRole('button', { name: new RegExp(`^(Filter: )?${group}\\b`) });
  await button.first().click();
  const popover = page.getByRole('dialog', { name: group });
  await popover.waitFor();
  await settle(page, 600);
  return { button: button.first(), popover };
}

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('library');
  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page, '/library');
  const grid = page.getByRole('grid', { name: /^Hands/ });
  await grid.locator('[role=row][data-key]').first().waitFor();
  await settle(page, 1200);
  const toolbar = page.getByRole('toolbar', { name: 'Filters' });
  await rec.shot(page, 'list', {
    tab: page.getByRole('tab', { name: 'Hand history' }),
    heading: page.getByRole('heading', { name: 'Hand history' }),
    filters: toolbar,
    list: grid,
    header: grid.locator('[role=row]').first(),
    firstRow: grid.locator('[role=row][data-key]').first(),
  });

  // Date: each option with the hands it would match.
  const date = await chip(page, 'Date');
  await rec.shot(page, 'date', { chip: date.button, popover: date.popover });
  await date.popover.getByRole('button', { name: /^Last 30 days/ }).click();
  await page.keyboard.press('Escape');
  await settle(page, 1200);

  // Position: a second filter on top.
  const pos = await chip(page, 'Position');
  await rec.shot(page, 'position', { chip: pos.button, popover: pos.popover });
  await pos.popover.getByRole('button', { name: /^BTN/ }).click();
  await page.keyboard.press('Escape');
  await settle(page, 1500);
  await rec.shot(page, 'filtered', {
    filters: toolbar,
    date: toolbar.getByRole('button', { name: /^Date:/ }),
    position: toolbar.getByRole('button', { name: /^Position:/ }),
    count: page.getByText(/ of [\d,]+ hands/).first(),
    clear: toolbar.getByRole('button', { name: 'Clear all' }),
    list: grid,
  });

  // Search: the hero's cards.
  await toolbar.getByRole('button', { name: 'Clear all' }).click();
  await settle(page, 1000);
  const search = await chip(page, 'Search');
  await search.popover.getByLabel("Hero's cards").fill('AK');
  await settle(page, 300);
  await rec.shot(page, 'search', {
    chip: search.button,
    popover: search.popover,
    cards: search.popover.getByLabel("Hero's cards"),
    submit: search.popover.getByRole('button', { name: 'Search' }),
  });
  await search.popover.getByRole('button', { name: 'Search' }).click();
  await page.keyboard.press('Escape');
  await settle(page, 1500);

  // Order: biggest pots first.
  const order = await chip(page, 'Order');
  await rec.shot(page, 'order', { chip: order.button, popover: order.popover });
  await order.popover.getByRole('button', { name: /^Biggest pots first/ }).click();
  await settle(page, 1500);
  await rec.shot(page, 'searched', {
    filters: toolbar,
    list: grid,
    firstRow: grid.locator('[role=row][data-key]').first(),
  });

  // A hand opens beside the list.
  await grid.locator('[role=row][data-key]').first().click();
  await page.locator('.rp').first().waitFor();
  await settle(page, 2000);
  await rec.shot(page, 'open', {
    list: grid,
    selected: grid.locator('[role=row][aria-selected=true]'),
    replayer: page.locator('.rp').first(),
    share: page.getByRole('button', { name: 'Share hand' }).first(),
    publish: page.getByRole('button', { name: /^Publish/ }).first(),
    close: page.getByRole('button', { name: 'Close replayer' }).first(),
  });
  await context.close();
  rec.save();
}
