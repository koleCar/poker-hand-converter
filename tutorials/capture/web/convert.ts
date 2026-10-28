// convert: dropping hand-history files on the converter (an empty account,
// saving to the library), the results per file and per hand, a preview, a
// single pasted hand in the replayer, and entering a hand by hand.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';

import { deleteAccount, ensureAccount, signIn } from '../lib/accounts.ts';
import { newContext, open, settle } from '../lib/browser.ts';
import { DEMO_HANDS } from '../lib/paths.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('convert');
  deleteAccount('fresh');
  await ensureAccount('fresh');
  await signIn(browser, 'fresh');
  const files = readdirSync(DEMO_HANDS).sort();
  const drop = files.slice(-5).map((f) => join(DEMO_HANDS, f));

  const context = await newContext(browser, { account: 'fresh' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page, '/convert');
  await rec.shot(page, 'empty', {
    privacy: page.getByText('Nothing is uploaded.'),
    paste: '.single',
    drop: '.conv-drop',
    chooseFiles: page.locator('.conv-drop').getByRole('button', { name: 'Choose files' }),
    chooseFolder: page.locator('.conv-drop').getByRole('button', { name: 'Choose a folder' }),
    rooms: '.conv-drop__hint',
    save: page.locator('label.conv-switch', { hasText: 'Save to my library' }),
    originals: page.locator('label.conv-switch', { hasText: 'Also keep the original files' }),
  });

  await page.locator('.conv-drop input[type=file]').first().setInputFiles(drop);
  await page.locator('section.conv-results').waitFor();
  await page.waitForFunction(() => /saved to your library/.test(document.querySelector('section.conv-results')?.textContent ?? ''), undefined, {
    timeout: 120_000,
  });
  await settle(page, 1500);
  await page.locator('section.conv-results').scrollIntoViewIfNeeded();
  await rec.shot(
    page,
    'results',
    {
      results: 'section.conv-results',
      heading: 'section.conv-results h3',
      tiles: page.locator('.conv-stat').first().locator('..'),
      sites: '.conv-sites',
      downloadAll: page.getByRole('button', { name: 'Download all' }),
      files: page.locator('li.conv-source').first().locator('..'),
      firstFile: 'li.conv-source',
      hands: page.locator('li.conv-hand').first().locator('..'),
      firstHand: 'li.conv-hand',
    },
    { fullPage: true, maxHeight: 3200 },
  );

  // A file's detail.
  await page.locator('li.conv-source').first().getByRole('button', { name: 'Detail' }).click();
  await settle(page, 500);
  await page.locator('li.conv-source').first().scrollIntoViewIfNeeded();
  await rec.shot(page, 'file-detail', {
    file: 'li.conv-source',
    chips: page.locator('li.conv-source').first().locator('.chip, .conv-chip').first(),
    download: page.locator('li.conv-source').first().getByRole('button', { name: 'Download' }),
  });

  // One hand's text.
  await page.locator('li.conv-hand').first().scrollIntoViewIfNeeded();
  await page.locator('li.conv-hand').first().getByRole('button', { name: 'Preview' }).click();
  const preview = page.locator('.conv-modal [role=dialog]');
  await preview.waitFor();
  await settle(page, 500);
  await rec.shot(page, 'preview', {
    dialog: preview,
    text: '.conv-pre',
    replay: preview.getByRole('button', { name: 'Open in replayer' }),
    copy: preview.getByRole('button', { name: 'Copy text' }),
    download: preview.getByRole('button', { name: 'Download' }),
  });
  await page.keyboard.press('Escape');

  // The library now has these hands: the new tabs.
  await open(page, '/convert');
  await rec.shot(page, 'tabs', {
    tabs: 'nav.shell__tabs',
    library: page.getByRole('tab', { name: 'Hand history' }),
    status: '.shell__status',
  });

  // A single hand, pasted.
  // A hand of the hero's that reaches the flop.
  const one = readFileSync(drop[0], 'utf8')
    .split(/\r?\n\r?\n\r?\n/)
    .find((h) => h.includes('*** FLOP ***') && /RailDemo: (calls|raises|bets)/.test(h))!
    .trim();
  await page.locator('textarea.single__area').fill(one);
  await page.getByRole('button', { name: 'Replay it' }).click();
  await page.locator('.rp').first().waitFor();
  await settle(page, 1500);
  await page.locator('.rp').first().scrollIntoViewIfNeeded();
  await page.locator('.rp').first().getByRole('button', { name: 'Flop', exact: true }).click();
  await settle(page, 1200);
  await rec.shot(page, 'pasted', {
    replayer: page.locator('.rp').first(),
    save: page.getByRole('button', { name: 'Save to my library' }).first(),
    share: page.getByRole('button', { name: 'Share hand' }).first(),
  });

  // Entering a hand by hand.
  await open(page, '/convert/manual');
  await rec.shot(page, 'manual', {
    title: page.getByRole('heading', { name: 'Enter a hand manually' }),
    game: page.getByRole('button', { name: /Game/ }).first(),
    players: page.getByRole('button', { name: 'Players' }).first(),
    table: '.pseat',
    output: page.getByRole('heading', { name: 'Your hand' }),
  }, { fullPage: true });
  await context.close();
  rec.save();
}
