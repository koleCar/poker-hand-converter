// players: the opponents of the demo library (opponent statistics turned
// on), the list, a search, one profile with its statistics and breakdown,
// a private note, and "hands with this player".

import type { Browser } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('players');

  // Off: what the page says before opponent statistics are turned on.
  const off = await newContext(browser, { account: 'demo' });
  await off.addInitScript(() => localStorage.removeItem('pokerconverter.statsVillains'));
  const offPage = await off.newPage();
  await open(offPage, '/players');
  const turnOn = offPage.getByRole('button', { name: 'Turn on opponent statistics' });
  await turnOn.waitFor();
  await settle(offPage, 800);
  await rec.shot(offPage, 'off', {
    subnav: offPage.getByRole('navigation', { name: 'Statistics' }),
    explain: offPage.getByRole('heading', { name: 'Opponent statistics are off' }),
    turnOn,
  });
  await off.close();

  const context = await newContext(browser, { account: 'demo' });
  await context.addInitScript(() => localStorage.setItem('pokerconverter.statsVillains', 'on'));
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await open(page, '/players');
  const list = page.getByRole('grid', { name: /^Opponents/ });
  await list.locator('[role=row]').nth(2).waitFor();
  await settle(page, 1500);
  await rec.shot(page, 'list', {
    toolbar: page.getByRole('toolbar', { name: 'Filters' }),
    search: page.getByRole('searchbox', { name: 'Search players' }).or(page.getByLabel('Search players')),
    game: page.getByRole('toolbar', { name: 'Filters' }).getByRole('group', { name: 'Game' }),
    list,
    header: list.locator('[role=row]').first(),
    first: list.locator('[role=row]').nth(1),
  });

  // The regular the hero has played most with.
  await list.locator('[role=row]').nth(1).click();
  const profile = page.getByRole('region').filter({ has: page.getByRole('button', { name: 'Close the profile' }) });
  await profile.waitFor();
  await settle(page, 2000);
  await rec.shot(
    page,
    'profile',
    {
      list,
      profile,
      facts: profile.getByText('Hands together').first(),
      result: profile.getByText('Your result against them').first(),
      hands: profile.getByRole('button', { name: /^Hands with this player/ }),
      note: profile.getByRole('textbox', { name: 'Note' }),
      stats: profile.getByText('Their statistics').first(),
      breakdown: profile.getByRole('tablist', { name: 'Breakdown' }),
    },
    { fullPage: true },
  );
  await profile.getByRole('textbox', { name: 'Note' }).fill('Opens wide on the button, folds to 3-bets a lot.');
  await profile.getByRole('textbox', { name: 'Note' }).blur();
  await page.getByText('Saved', { exact: true }).waitFor({ timeout: 15_000 }).catch(() => {});
  await settle(page, 800);
  await rec.shot(
    page,
    'note',
    { profile, note: profile.getByRole('textbox', { name: 'Note' }), hands: profile.getByRole('button', { name: /^Hands with this player/ }) },
    { fullPage: true },
  );

  // Search by the start of a name.
  const search = page.getByRole('toolbar', { name: 'Filters' }).getByRole('searchbox').first();
  const name = (await list.locator('[role=row]').nth(3).locator('[role=gridcell]').first().innerText()).trim();
  await search.fill(name.slice(0, 4));
  await settle(page, 1500);
  await rec.shot(page, 'search', { search, list });

  await profile.getByRole('button', { name: /^Hands with this player/ }).click().catch(async () => {
    await list.locator('[role=row]').nth(1).click();
    await page.getByRole('button', { name: /^Hands with this player/ }).click();
  });
  await page.waitForURL(/\/library/);
  await page.getByRole('grid', { name: /^Hands/ }).locator('[role=row][data-key]').first().waitFor();
  await settle(page, 1500);
  await rec.shot(page, 'hands', {
    filters: page.getByRole('toolbar', { name: 'Filters' }),
    player: page.getByRole('toolbar', { name: 'Filters' }).getByRole('button', { name: /MoodyBison97|Player|Search/ }).first(),
    list: page.getByRole('grid', { name: /^Hands/ }),
  });
  await context.close();
  rec.save();
}
