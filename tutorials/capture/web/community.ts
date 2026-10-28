// community: the forum between the two demo accounts (seeded by
// `npm run demo-data`) - the feed, a hand thread with its replayer and
// comments, publishing a hand and starting a thread (filled in, not sent),
// notifications, and a profile.

import type { Browser } from 'playwright';

import { psql, userId } from '../lib/accounts.ts';
import { newContext, open, settle } from '../lib/browser.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('community');
  const demo = userId('demo');
  const thread = psql(
    `select '/f/' || b.slug || '/' || p.public_id from public.posts p join public.boards b on b.id = p.board_id
     where p.author_id = '${demo}' and p.published_hand_id is not null limit 1;`,
  );
  if (!thread) throw new Error('community: no seeded thread; run `npm run demo-data`.');
  // Notifications unread again, so the bell and the list show them as new.
  psql(`update public.notifications set read_at = null where user_id = '${demo}';`);

  const context = await newContext(browser, { account: 'demo' });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await open(page, '/');
  await page.locator('article').first().waitFor();
  await settle(page, 1500);
  await rec.shot(page, 'feed', {
    forum: page.getByRole('tab', { name: 'Forum' }),
    boards: page.getByRole('navigation', { name: 'All boards' }),
    sort: page.getByRole('link', { name: 'New', exact: true }),
    search: page.getByRole('searchbox', { name: 'Search' }),
    newPost: page.getByRole('link', { name: 'New post' }),
    first: page.locator('article').first(),
    votes: page.locator('article').first().getByRole('button', { name: 'Upvote' }),
    bell: 'a.bell',
  });

  await open(page, thread);
  await page.locator('section#replay .rp').waitFor();
  await settle(page, 2000);
  await rec.shot(
    page,
    'thread',
    {
      title: page.locator('h1').first(),
      controls: page.getByRole('button', { name: /^(Follow thread|Following)$/ }),
      replay: 'section#replay',
      spot: page.getByRole('button', { name: 'Comment on this spot' }),
      comments: 'section#comments',
      firstComment: 'section#comments li[id^="c-"]',
      composer: 'form#composer',
    },
    { fullPage: true },
  );
  await page.locator('section#replay .rp').getByRole('button', { name: 'River', exact: true }).click();
  await settle(page, 800);
  await page.getByRole('button', { name: 'Comment on this spot' }).click();
  await settle(page, 800);
  await page.getByPlaceholder('Add to the discussion').fill('On this river I think a smaller bet gets called by more of his hands.');
  await settle(page, 500);
  await rec.shot(
    page,
    'comment',
    {
      composer: 'form#composer',
      attached: page.getByText(/^Commenting on:/),
      submit: page.locator('form#composer').getByRole('button', { name: 'Comment' }),
    },
    { fullPage: true },
  );

  // Publishing one of your hands: the dialog, filled in, not sent.
  await open(page, '/library');
  await page.getByRole('grid', { name: /^Hands/ }).locator('[role=row][data-key]').nth(2).click();
  await page.locator('.rp').first().waitFor();
  await settle(page, 1200);
  await page.getByRole('button', { name: 'Publish hand' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Publish this hand' });
  await dialog.waitFor();
  await dialog.getByLabel('Title (optional)').fill('A hand from Sunday night');
  await settle(page, 600);
  await rec.shot(page, 'publish', {
    trigger: page.getByRole('button', { name: 'Publish hand' }).first(),
    dialog,
    title: dialog.getByLabel('Title (optional)'),
    names: dialog.getByRole('group', { name: 'Names' }).or(dialog.locator('fieldset')).first(),
    publish: dialog.getByRole('button', { name: 'Publish' }),
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Starting a thread about an already published hand.
  const published = psql(
    `select ph.public_id from public.published_hands ph where ph.author_id = '${demo}' limit 1;`,
  );
  await open(page, `/submit${published ? `?hand=${published}` : ''}`);
  await page.getByLabel('Title').fill('Would you have called the river?');
  await settle(page, 800);
  await rec.shot(page, 'submit', {
    board: page.getByLabel('Board'),
    title: page.getByLabel('Title'),
    hand: page.getByText(/^Attached:|To post a hand/).first(),
    poll: page.getByText('Ask readers what they would do').first(),
    post: page.getByRole('button', { name: 'Post' }),
  }, { fullPage: true });

  await open(page, '/notifications');
  await settle(page, 1000);
  await rec.shot(page, 'notifications', {
    heading: page.getByRole('heading', { name: 'Notifications' }),
    list: page.locator('main ol').first(),
    first: page.locator('main ol li').first(),
    markAll: page.getByRole('button', { name: 'Mark all as read' }),
    bell: 'a.bell',
  }, { fullPage: true });

  await open(page, '/u/RailDemo');
  await settle(page, 1000);
  await rec.shot(page, 'profile', {
    name: page.locator('h1').first(),
    hands: page.getByText('Published hands').first(),
  });
  await context.close();
  rec.save();
}
