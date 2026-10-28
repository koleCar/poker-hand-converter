// replayer: one of the demo hands stepped through - streets, the pot odds
// when the hero faces a bet, the result, the settings and the action log -
// then shared as a link, and the shared page as a stranger sees it.

import type { Browser, Locator, Page } from 'playwright';


import { psql, userId } from '../lib/accounts.ts';
import { newContext, open, settle } from '../lib/browser.ts';
import { WEB_URL } from '../lib/paths.ts';
import { Recorder } from '../lib/recorder.ts';

/** Step forward until the pot-odds box shows (the hero facing a bet). */
async function toPotOdds(page: Page, rp: Locator): Promise<boolean> {
  const odds = rp.getByRole('group', { name: 'Pot odds' });
  for (let i = 0; i < 40; i++) {
    if (await odds.isVisible().catch(() => false)) return true;
    await rp.getByRole('button', { name: 'Next action' }).click();
    await page.waitForTimeout(250);
  }
  return false;
}

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('replayer');
  const demo = userId('demo');
  if (!demo) throw new Error('No demo account: run `npm run demo-data`.');
  const context = await newContext(browser, { account: 'demo' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  // A cash hand the hero won at showdown after calling a bet on the river.
  const [key, cards, board] = psql(`
    select id, array_to_string(hero_cards, ''), array_to_string(board_cards[1:3], ' ') from public.hands
    where owner_id = '${demo}' and game_format = 'cash' and went_to_showdown and hero_profit > 0
      and exists (select 1 from jsonb_array_elements(phf->'actions') a
                  where a->>'street' = 'river' and a->>'type' = 'call' and a->>'player' = hero_name)
    order by total_pot desc limit 1;`).split('|');
  if (!key) throw new Error('replayer: no suitable demo hand');
  await open(page, '/library');
  const toolbar = page.getByRole('toolbar', { name: 'Filters' });
  await toolbar.getByRole('button', { name: /^(Filter: )?Search/ }).click();
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByLabel("Hero's cards").fill(cards);
  await search.getByLabel('Board').fill(board);
  await search.getByRole('button', { name: 'Search' }).click();
  await page.keyboard.press('Escape');
  await settle(page, 1500);
  const grid = page.getByRole('grid', { name: /^Hands/ });
  await grid.locator(`[role=row][data-key="${key}"]`).click();
  const rp = page.locator('.rp').first();
  await rp.waitFor();
  await settle(page, 2000);

  await rec.shot(page, 'start', {
    replayer: rp,
    header: rp.locator('.rp__header'),
    table: rp.locator('.ptable, .rp__stage').first(),
    hero: rp.locator('.pseat', { hasText: 'RailDemo' }),
    transport: rp.locator('.rp__transport'),
    play: rp.getByRole('button', { name: 'Play' }),
    next: rp.getByRole('button', { name: 'Next action' }),
    streets: rp.getByRole('group', { name: 'Jump to street' }),
    speed: rp.getByRole('group', { name: 'Playback speed' }),
    scrub: rp.getByRole('slider', { name: 'Position in hand' }),
  }, { fullPage: true });

  await rp.getByRole('button', { name: 'Flop', exact: true }).click();
  await settle(page, 1200);
  await rec.shot(page, 'flop', {
    replayer: rp,
    board: rp.locator('.rp__board, .pboard').first(),
    pot: rp.locator('.rp__pot, .ppot').first(),
    caption: rp.locator('.rp__caption'),
    flop: rp.getByRole('button', { name: 'Flop', exact: true }),
  }, { fullPage: true });

  await rp.getByRole('button', { name: 'Turn', exact: true }).click();
  await settle(page, 400);
  if (!(await toPotOdds(page, rp))) throw new Error('replayer: the hero never faced a bet');
  await settle(page, 800);
  await rec.shot(page, 'odds', {
    replayer: rp,
    odds: rp.getByRole('group', { name: 'Pot odds' }),
    caption: rp.locator('.rp__caption'),
  }, { fullPage: true });

  await rp.getByRole('button', { name: 'Jump to end' }).click();
  await settle(page, 1500);
  if (!(await page.locator('.rp-ov--result').isVisible().catch(() => false))) {
    await rp.getByRole('button', { name: /^(Result|Showdown)$/ }).last().click();
    await settle(page, 800);
  }
  await rec.shot(page, 'result', {
    replayer: rp,
    sheet: page.locator('.rp-ov--result'),
    resultButton: rp.getByRole('button', { name: /Result|Showdown/ }).last(),
  }, { fullPage: true });
  // Close the result sheet.
  const closeResult = page.getByRole('button', { name: /^Close (showdown|result)$/ });
  if (await closeResult.isVisible().catch(() => false)) await closeResult.click();
  await settle(page, 600);

  await rp.getByRole('button', { name: 'Replayer settings' }).click();
  await settle(page, 800);
  await rec.shot(page, 'settings', {
    replayer: rp,
    sheet: page.locator('.rp-ov--settings'),
    known: page.locator('label.rp__setting', { hasText: 'Show known cards' }),
    odds: page.locator('label.rp__setting', { hasText: 'Show pot odds' }),
    bb: page.locator('label.rp__setting', { hasText: 'Display chips in big blinds' }),
  }, { fullPage: true });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await settle(page, 500);

  await rp.getByRole('button', { name: 'Action log' }).click();
  await settle(page, 800);
  await rec.shot(page, 'log', {
    replayer: rp,
    log: page.locator('.rp-ov--log'),
    logButton: rp.getByRole('button', { name: 'Action log' }),
  }, { fullPage: true });
  await page.getByRole('button', { name: 'Close action log' }).click();
  await settle(page, 500);

  // Share: a link anyone can open, the names hidden unless turned on.
  await rp.getByRole('button', { name: 'Share hand' }).click();
  const panel = page.getByRole('dialog', { name: 'Share this hand' });
  await panel.waitFor();
  await page.locator('input.share__url').waitFor();
  await settle(page, 1000);
  const url = await page.locator('input.share__url').inputValue();
  await rec.shot(page, 'share', {
    trigger: rp.getByRole('button', { name: 'Share hand' }),
    panel,
    url: 'input.share__url',
    copy: panel.getByRole('button', { name: 'Copy' }),
    names: panel.getByText("Show the players' names"),
  }, { fullPage: true });
  await context.close();

  // The link, opened by someone without an account.
  const stranger = await newContext(browser);
  const shared = await stranger.newPage();
  await shared.goto(url.startsWith('http') ? url : `${WEB_URL}${url}`);
  await settle(shared, 2500);
  await rec.shot(shared, 'shared-page', {
    bar: 'header.sharepage__bar',
    replay: 'section.sharepage__replay',
    seats: shared.locator('.pseat').first(),
    cta: 'section.sharepage__cta',
  });
  await stranger.close();
  rec.save();
}
