// `npm run demo-data [--no-load] [--skip-analysis]`
//
// 1. Demo hand files from the committed corpus, every name made up
//    (scripts/demo/generate.ts) -> tutorials/.demo/hands/.
// 2. Unless --no-load: on the tutorials' stack (`npm run stack` first), the
//    demo accounts, the hands loaded the way a user loads them (the web's
//    converter, saving to the library), the statistics and opponents
//    derived by visiting their pages, the analysis run, and a little forum
//    activity between two demo accounts. Re-running is safe: the converter
//    skips hands already saved, the forum is seeded once.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

import { ensureAccount, psql, signIn } from '../capture/lib/accounts.ts';
import { launch, newContext, open, settle } from '../capture/lib/browser.ts';
import { DEMO_HANDS, SESSIONS_DIR, type AccountKey } from '../capture/lib/paths.ts';
import { startWebServer } from '../capture/lib/web.ts';
import { generate } from './demo/generate.ts';

const args = new Set(process.argv.slice(2));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const made = generate();
console.log(
  `Demo hands: ${made.hands} hands in ${made.files} files, ${made.names} demo names` +
    (made.dropped ? `, ${made.dropped} source file(s) left out (did not survive the rewrite unchanged)` : ''),
);
if (args.has('--no-load')) process.exit(0);

const demoFiles = readdirSync(DEMO_HANDS)
  .filter((f) => f.endsWith('.txt'))
  .sort()
  .map((f) => join(DEMO_HANDS, f));

const stopWeb = await startWebServer();
const browser = await launch();
try {
  for (const key of ['demo', 'friend'] as AccountKey[]) {
    await ensureAccount(key);
    await signIn(browser, key);
    console.log(`account ${key}: signed in`);
  }

  // The demo account: every demo file; the friend: a handful, to publish from.
  await upload('demo', demoFiles);
  await upload('friend', demoFiles.slice(0, 3));
  await derive('demo', !args.has('--skip-analysis'));
  seedForum();
} finally {
  await browser.close();
  await stopWeb();
}

async function withPage(key: AccountKey, fn: (page: Page) => Promise<void>): Promise<void> {
  const context = await newContext(browser, { account: key });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  try {
    await fn(page);
    await context.storageState({ path: join(SESSIONS_DIR, `${key}.json`) });
  } finally {
    await context.close();
  }
}

/** The converter, saving to the library, exactly as a user drops files. */
async function upload(key: AccountKey, files: string[]): Promise<void> {
  await withPage(key, async (page) => {
    await open(page, '/convert');
    const save = page.locator('label.conv-switch', { hasText: 'Save to my library' }).locator('input');
    await page.locator('.conv-drop input[type=file]').first().setInputFiles(files);
    await page.waitForTimeout(1500);
    // Converting, then saving: wait for both to end.
    await page.waitForFunction(
      () => {
        const progress = document.querySelector('section.conv-progress');
        const stop = progress && [...progress.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Stop');
        const results = document.querySelector('section.conv-results');
        return Boolean(results) && !stop && !document.querySelector('section.conv-progress .conv-bar');
      },
      undefined,
      { timeout: 30 * 60_000, polling: 1000 },
    );
    await settle(page, 2000);
    const line = (await page.locator('section.conv-results').innerText()).split('\n').slice(0, 3).join(' | ');
    console.log(`upload ${key}: ${files.length} files, save switch ${(await save.isChecked()) ? 'on' : 'off'}: ${line}`);
  });
}

/** Statistics, opponents and the analysis, derived the way the pages do it. */
async function derive(key: AccountKey, analysis: boolean): Promise<void> {
  await withPage(key, async (page) => {
    await open(page, '/stats');
    await page.waitForFunction(() => !document.querySelector('.stats-coverage'), undefined, {
      timeout: 30 * 60_000,
      polling: 2000,
    });
    console.log('stats: derived');
    await open(page, '/players');
    const turnOn = page.getByRole('button', { name: 'Turn on opponent statistics' });
    if (await turnOn.isVisible().catch(() => false)) {
      await turnOn.click();
      await page.getByRole('grid', { name: /Opponents/ }).waitFor({ timeout: 30 * 60_000 });
    }
    await settle(page, 1500);
    console.log('players: opponents on');
    if (!analysis) return;
    await open(page, '/analysis');
    const run = page.getByRole('button', { name: /^(Run analysis|Analyse new hands|Bring it up to date)$/ });
    if (await run.isVisible().catch(() => false)) {
      await run.click();
      await page.waitForTimeout(3000);
      await page.waitForFunction(
        () => ![...document.querySelectorAll('[role=status]')].some((el) => /Analysing/.test(el.textContent ?? '')),
        undefined,
        { timeout: 90 * 60_000, polling: 5000 },
      );
    }
    await settle(page, 1500);
    console.log('analysis: done');
    // The weekly plan is built on the first visit of the week.
    await open(page, '/analysis/plan');
    await page.waitForTimeout(5000);
  });
}

/** SQL run as a signed-in user (RLS, rate limits and checks as in the app). */
function asUser(uid: string, sql: string): string {
  return `
    begin;
    select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: uid, role: 'authenticated' }))}, true) \\g /dev/null
    set local role authenticated;
    ${sql}
    commit;`;
}

/** A few threads between the two demo accounts, once. */
function seedForum(): void {
  const demo = psql(`select id from auth.users where email = 'demo@rail.test';`);
  const friend = psql(`select id from auth.users where email = 'friend@rail.test';`);
  const count = (uid: string) => psql(`select count(*) from public.posts where author_id = ${lit(uid)};`);
  if (count(demo) !== '0') {
    console.log('forum: already seeded');
    return;
  }
  // The demo account's biggest pot with a decision on the river, published
  // with pseudonyms (the default), and a thread about it.
  const handId = psql(`
    select id from public.hands where owner_id = ${lit(demo)} and went_to_showdown and game_format = 'cash'
    order by abs(hero_profit) desc nulls last limit 1;`);
  const friendPosts = count(friend) === '0';
  const posts = [
    friendPosts && psql(
      asUser(
        friend,
        `select (public.create_post('general', 'How many tables do you play at once?',
          'Two tables felt slow, four felt like a blur. Where did you settle, and did your win rate change with it?'))->>'publicId';`,
      ),
    ),
    friendPosts && psql(
      asUser(
        friend,
        `select (public.create_post('nlhe', 'Floating the flop in position: how often do you follow through?',
          'Single raised pot, I call the c-bet on the button with overcards and a backdoor draw. Turn checks to me. How often are you betting here?'))->>'publicId';`,
      ),
    ),
  ];
  const published = psql(
    asUser(demo, `select (public.publish_hand(${lit(handId)}::uuid, 'pseudonyms', 'A big pot to showdown'))->>'publicId';`),
  );
  const mine = psql(
    asUser(
      demo,
      `select (public.create_post('nlhe', 'Big pot to showdown - how would you play the river?',
        'My biggest pot of the week. Step to the river and tell me how you would have played it.',
        ${lit(published)}))->>'publicId';`,
    ),
  );
  psql(
    asUser(
      friend,
      `select public.vote_post(${lit(mine)}, 1);
       select public.create_comment(${lit(mine)}, 'I like the way you played the turn. On the river I would size down a little.');`,
    ),
  );
  psql(
    asUser(
      demo,
      `select public.create_comment(${lit(mine)}, 'Thanks! I wanted to keep his weaker hands in.');
       ${posts[1] ? `select public.vote_post(${lit(posts[1])}, 1);
       select public.create_comment(${lit(posts[1])}, 'Most of the time when the turn brings a backdoor draw.');` : ''}`,
    ),
  );
  psql(
    asUser(
      friend,
      `select public.create_comment(${lit(mine)}, '@RailDemo fair enough, against that opponent it makes sense.', 2);`,
    ),
  );
  console.log(`forum: seeded ${posts.length + 1} threads with comments and notifications`);
}
