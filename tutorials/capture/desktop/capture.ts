// The desktop app's screens, captured in a plain browser: its Vite server
// (`app-server.ts`) with the IPC mocked (`tauri-mock.ts`), driven through the
// app's own navigation - clicks, the sidebar, the command palette.
//
// - `captureDesktopSetup`: the `desktop-setup` tutorial - the first-run
//   screen (sign in, the folders Rail found, import everything or only new
//   hands), Today while the old hands import, Settings (folders, account and
//   sync, appearance), the command palette, and a look at Hands, Reports and
//   Players.
// - `captureDesktopApp`: the `desktop-app` tutorial - the screens in daily
//   use: Today's session and biggest pots, Hands (filter chips with counts,
//   saved filters, the replayer beside the list, a tag and the note),
//   Reports (one room's money, statistics, breakdowns, the 13 x 13 grid),
//   Players (a profile, colour tag, label, note, hands with them), Analysis
//   (session review, top leaks), the command palette and the preferences.
// - `captureHudScreens`: the app's side of the `hud` tutorial (shot ids
//   `app-...`) - the HUD screen's two views: At the tables (the header's
//   status pill, the game cards, the rooms and their ⋯ menus, why there is
//   no switch, the macOS Accessibility row) and the Editor (a preset, a
//   statistic dragged from the drawer onto the panel's grid, the user's own
//   copy, the cell's settings popover, the preview per room and size, the
//   popup's sections, saving it, a rule at the tables), then the HUD popup
//   window.
//
// Needs the app's Vite server on APP_URL (`startAppServer()`).

import type { Browser, BrowserContext, Locator, Page } from 'playwright';

import { SCALE, VIEWPORT } from '../lib/browser.ts';
import { APP_URL } from '../lib/paths.ts';
import { Recorder, type ShotOptions, type Target } from '../lib/recorder.ts';
import { buildMockData, mockNames, type MockData, type SceneName } from './mock-data.ts';
import { addTauriMock } from './tauri-mock.ts';

/** The HUD popup's window (`app/src-tauri/src/popup.rs` POPUP_SIZE). */
const POPUP_VIEWPORT = { width: 380, height: 560 };

interface AppPage {
  context: BrowserContext;
  page: Page;
  data: MockData;
  /** Every made-up name the mock serves, for the name guard. */
  names: string[];
}

/** A browser context for the app (the web's `newContext` is for the web app), with the mock installed. */
async function openApp(
  browser: Browser,
  scene: SceneName,
  route: string,
  viewport: { width: number; height: number } = VIEWPORT,
): Promise<AppPage> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'Europe/Zagreb',
  });
  const data = await addTauriMock(context, { scene, data: buildMockData() });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      console.log(`  [app ${message.type()}] ${message.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (error) => console.log(`  [app error] ${error.message}`));
  await page.goto(`${APP_URL}/${route}`, { waitUntil: 'domcontentloaded' });
  // The Vite server is a debug build: Settings ends with the developer panels
  // (`import.meta.env.DEV`), which a release build leaves out. Hidden, as shipped.
  await page.addStyleTag({ content: '#section-about ~ section { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  return { context, page, data, names: mockNames(data) };
}

/** Wait for the page to be quiet: the text, the fonts, a moment for the polls. */
async function ready(page: Page, text: string | RegExp, ms = 400): Promise<void> {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(ms);
}

/** Scroll the app's main column so `target` starts `offset` pixels from the top. */
async function scrollTo(page: Page, target: Locator, offset = 24): Promise<void> {
  await target.first().evaluate((node, gap) => {
    const main = node.closest('main');
    if (!main) return;
    const top = node.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - gap;
    main.scrollTo({ top, behavior: 'instant' as ScrollBehavior });
  }, offset);
  await page.waitForTimeout(250);
}

async function scene(page: Page, name: SceneName): Promise<void> {
  await page.evaluate((next) => {
    (window as unknown as { __railMock: { scene(name: string): void } }).__railMock.scene(next);
  }, name);
  await page.waitForTimeout(400);
}

/**
 * `rec.shot`, with every target cut to the window: a card taller than the
 * window (the app scrolls its main column, not the page) is framed by the
 * part the shot shows. A target with nothing in the window fails the shot.
 */
async function take(rec: Recorder, page: Page, id: string, targets: Record<string, Target>, options: ShotOptions): Promise<void> {
  const view = page.viewportSize() ?? VIEWPORT;
  const boxes: Record<string, Target> = {};
  for (const [name, target] of Object.entries(targets)) {
    let box: { x: number; y: number; width: number; height: number } | null;
    if (typeof target === 'string') box = await page.locator(target).first().boundingBox();
    else if ('boundingBox' in target) box = await target.first().boundingBox();
    else box = { x: target.x, y: target.y, width: target.w, height: target.h };
    if (!box) throw new Error(`${rec.slug}/${id}: target ${name} is not visible`);
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const right = Math.min(view.width, box.x + box.width);
    const bottom = Math.min(view.height, box.y + box.height);
    if (right - x < 4 || bottom - y < 4) throw new Error(`${rec.slug}/${id}: target ${name} is outside the window`);
    boxes[name] = { x, y, w: right - x, h: bottom - y };
  }
  await rec.shot(page, id, boxes, options);
}

/** Commands no handler answered: printed, so the mock can grow. */
async function reportUnknown(page: Page, where: string): Promise<void> {
  const unknown = await page
    .evaluate(() => (window as unknown as { __railMock?: { unknown: string[] } }).__railMock?.unknown ?? [])
    .catch(() => []);
  if (unknown.length > 0) console.log(`  ${where}: commands the mock did not answer: ${unknown.join(', ')}`);
}

/** The app's command palette: open, optionally type, wait for the list. */
async function palette(page: Page, query?: string): Promise<Locator> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const input = page.getByRole('combobox', { name: 'Command palette' });
  await input.waitFor({ state: 'visible' });
  if (query) {
    await input.pressSequentially(query, { delay: 30 });
    await page.waitForTimeout(350);
  }
  return input;
}

/* ===================================================== desktop-setup - */

export async function captureDesktopSetup(browser: Browser): Promise<void> {
  const rec = new Recorder('desktop-setup');
  const { context, page, names } = await openApp(browser, 'firstRun', '');
  const shot = (id: string, targets: Record<string, Target>, options: ShotOptions = {}) =>
    take(rec, page, id, targets, { allowNames: names, ...options });
  try {
    /* The first-run screen: the window opens on it until it is finished. */
    await ready(page, /Rail found 2 folders/);
    const steps = page.locator('ol > li');
    const signIn = page.getByRole('button', { name: 'Sign in in your browser' });
    const folderTable = steps.nth(1).locator('table');
    const importAll = page.locator('label').filter({ hasText: 'Import everything' });
    const onlyNew = page.locator('label').filter({ hasText: 'Only new hands' });
    const watch = page.getByRole('button', { name: /^Watch \d+ folders?$/ });
    await shot('firstrun', {
      welcome: page.getByRole('heading', { name: 'Welcome to Rail' }),
      signInStep: steps.nth(0),
      signIn,
      useOffline: page.getByRole('button', { name: 'Use offline' }),
      folderStep: steps.nth(1),
      folderTable,
      pokerstarsRow: folderTable.locator('tr').filter({ hasText: 'PokerStars' }),
      weplayRow: folderTable.locator('tr').filter({ hasText: 'WePlay' }),
      unverified: page.getByText('This default folder has not been confirmed'),
      addManually: page.getByRole('button', { name: 'Add a folder manually…' }),
      importChoice: page.locator('fieldset').filter({ hasText: 'Hands already in these folders' }),
      importAll,
      onlyNew,
      watch,
      skip: page.getByRole('button', { name: 'Skip for now' }),
    });

    /* Step 1: sign in in the browser; the window waits for it. */
    await signIn.click();
    await ready(page, /Finish signing in in your browser/);
    await shot('firstrun-signing-in', {
      signInStep: steps.nth(0),
      waiting: page.getByText(/Finish signing in in your browser/),
      waitingHint: page.getByText('Already signed in on the web?'),
      openAgain: page.getByRole('button', { name: 'Open the page again' }),
      cancel: page.getByRole('button', { name: 'Cancel' }),
    });
    // The browser hands the app its `rail://auth/callback`: signed in.
    await page.evaluate(() => {
      (window as unknown as { __railMock: { account(next: unknown): void } }).__railMock.account({
        state: 'signedIn',
        email: 'demo@rail.test',
        userId: '00000000-0000-4000-8000-00000000d3e0',
        online: true,
        notice: null,
      });
    });
    await ready(page, 'Signed in as demo@rail.test');

    /* Step 2: a folder Rail did not find, added by hand. */
    await page.getByRole('button', { name: 'Add a folder manually…' }).click();
    await ready(page, 'Added by you');
    await shot('firstrun-folders', {
      signedIn: page.getByText('Signed in as demo@rail.test'),
      signInStep: steps.nth(0),
      folderStep: steps.nth(1),
      folderTable,
      addedRow: folderTable.locator('tr').filter({ hasText: 'Added by you' }),
      importAll,
      onlyNew,
      watch,
    });

    /* Import everything: the default, confirmed. */
    await watch.click();
    await ready(page, /Rail is watching 3 folders/);
    await shot('firstrun-done', {
      folderStep: steps.nth(1),
      watching: page.getByText(/Rail is watching 3 folders/),
      tableStep: steps.nth(2),
      goToday: page.getByRole('button', { name: 'Go to Today' }),
    });

    /* Today, while the old hands import. */
    await scene(page, 'imported');
    await page.getByRole('button', { name: 'Go to Today' }).click();
    await ready(page, 'Current session', 800);
    const lines = page.locator('main p').filter({ has: page.getByRole('button') });
    await shot('today', {
      title: page.getByRole('heading', { name: 'Today', level: 1 }),
      accountLine: lines.filter({ hasText: 'Signed in as' }),
      syncLine: lines.filter({ hasText: /Syncing .* with the web/ }),
      hudLine: lines.filter({ hasText: 'HUD:' }),
      session: page.locator('section[aria-labelledby="today-session"]'),
      sessionTiles: page.locator('section[aria-labelledby="today-session"] dl').first(),
      sessionStats: page.locator('section[aria-labelledby="today-session"] table').first(),
      allReports: page.getByRole('link', { name: 'All reports' }),
    });
    const importSection = page.locator('section[aria-labelledby="today-import"]');
    await scrollTo(page, importSection);
    await shot('today-import', {
      importSection,
      importTable: importSection.locator('table'),
      pokerstarsFolder: importSection.locator('tr').filter({ hasText: 'PokerStars/HandHistory' }).first(),
      backfill: importSection.locator('progress').locator('xpath=..'),
      backfillBar: importSection.locator('progress'),
      pauseImport: page.getByRole('button', { name: 'Pause import' }),
      storeTiles: page.locator('section[aria-labelledby="today-store"] dl'),
    });

    /* The command palette: Cmd/Ctrl + K from anywhere. */
    const input = await palette(page);
    const dialog = page.locator('[role="listbox"][aria-label="Command palette"]');
    await shot('palette', {
      sidebarSearch: page.getByRole('button', { name: 'Search or run a command' }),
      paletteInput: input,
      paletteList: dialog,
      screensGroup: dialog.getByRole('group').filter({ hasText: 'Screens' }),
      commandsGroup: dialog.getByRole('group').filter({ hasText: 'Commands' }),
    });
    await input.pressSequentially('folders', { delay: 30 });
    await page.waitForTimeout(350);
    const foldersOption = dialog.getByRole('option', { name: /Settings: Hand-history folders/ });
    await shot('palette-folders', {
      paletteInput: input,
      foldersOption,
      paletteList: dialog,
    });

    /* Settings, Folders: the watched folders and their controls. */
    await foldersOption.click();
    await ready(page, 'Hand-history folders', 800);
    const folders = page.locator('section[aria-labelledby="settings-folders"]');
    const firstCard = folders.getByRole('list', { name: 'Watched folders' }).locator('xpath=./li[1]');
    await scrollTo(page, folders, 16);
    await shot('settings-folders', {
      foldersSection: folders,
      addFolder: page.getByRole('button', { name: 'Add a folder…' }),
      findAgain: page.getByRole('button', { name: 'Find folders again' }),
      folderCard: firstCard,
      folderFacts: firstCard.locator('dl'),
      folderBackfill: firstCard.locator('progress').locator('xpath=..'),
      folderSettings: firstCard.locator('fieldset'),
      roomSelect: firstCard.locator('select'),
      changeFolder: firstCard.getByRole('button', { name: 'Change folder…' }),
      removeFolder: firstCard.getByRole('button', { name: 'Remove…' }),
    });

    /* Settings, Account: who is signed in, the plan, sync. */
    await palette(page, 'account');
    await page.getByRole('option', { name: /Settings: Account and sync/ }).click();
    await ready(page, 'Signed in as demo@rail.test', 600);
    const account = page.locator('section[aria-labelledby="settings-account"]');
    await scrollTo(page, account, 16);
    const syncLine = account.getByText(/^Syncing [\d,]+ of [\d,]+ hands\.$/);
    await shot('settings-account', {
      accountSection: account,
      signedIn: account.getByText('Signed in as demo@rail.test'),
      signOut: account.getByRole('button', { name: 'Sign out' }),
      plan: account.getByText('Everything in Rail is available.'),
      syncStatus: syncLine,
      syncSpeed: account.getByText(/hands a second/),
      syncNow: account.getByRole('button', { name: 'Sync now' }),
      pauseSync: account.getByRole('button', { name: 'Pause sync' }),
    });

    /* Settings, Appearance: theme, density, language. */
    await palette(page, 'appearance');
    await page.getByRole('option', { name: /Settings: Appearance and language/ }).click();
    const appearance = page.locator('#section-appearance');
    await appearance.waitFor({ state: 'visible' });
    await scrollTo(page, appearance, 16);
    await shot('settings-appearance', {
      appearance,
      theme: appearance.getByRole('group', { name: 'Theme' }),
      density: appearance.getByRole('group', { name: 'Density' }),
      language: appearance.getByRole('group', { name: 'Language' }),
      startup: page.locator('#section-startup'),
    });
    await appearance.getByRole('button', { name: 'Light', exact: true }).click();
    await page.waitForTimeout(500);
    await shot('settings-appearance-light', {
      appearance,
      theme: appearance.getByRole('group', { name: 'Theme' }),
      light: appearance.getByRole('button', { name: 'Light', exact: true }),
    });
    await appearance.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.waitForTimeout(500);

    /* Hands: the list, and a hand in the replayer. */
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Hands' }).click();
    await ready(page, '48,210 hands', 800);
    const grid = page.getByRole('grid').first();
    const firstRow = grid.locator('[data-key]').first();
    await shot('hands', {
      sidebarHands: page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Hands' }),
      count: page.getByText('48,210 hands'),
      filters: page.getByRole('toolbar').first(),
      handList: grid,
      firstRow,
    });
    await firstRow.click();
    const replayer = page.locator('.rp').first();
    await replayer.waitFor({ state: 'visible' });
    // The river: the board out, the last bets made.
    await page.getByRole('button', { name: 'River', exact: true }).click();
    await page.waitForTimeout(800);
    const handPanel = page.locator('section[aria-label="Hand"]');
    const note = handPanel.locator('textarea[aria-label="Note"]');
    const addTag = handPanel.locator('input[aria-label="Add a tag"]');
    const annotations = note.locator('xpath=ancestor::label[1]/..');
    await shot('hands-replayer', {
      handList: grid,
      selectedRow: firstRow,
      replayer,
      streets: page.getByRole('button', { name: 'River', exact: true }).locator('xpath=..'),
      annotations,
      tagInput: addTag,
      tags: handPanel.locator('ul[aria-labelledby]').first(),
      note,
    });
    // The showdown: who showed what.
    await page.getByRole('button', { name: 'Showdown', exact: true }).click();
    await page.waitForTimeout(800);
    await shot('hands-showdown', {
      replayer,
      showdown: page.getByText('a pair of Kings').locator('xpath=ancestor::*[.//*[text()="Showdown"]][1]'),
    });
    await page.keyboard.press('Escape');

    /* Reports: the result over time and the breakdowns. */
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }).click();
    await ready(page, 'Winnings', 1000);
    await shot('reports', {
      sidebarReports: page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Reports' }),
      summary: page.locator('main section').first(),
      graph: page.locator('section[aria-labelledby="reports-graph"]'),
      currencyNotice: page.getByText(/These hands span more than one currency/),
    });

    /* Players: the opponents, and one profile. */
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Players' }).click();
    await ready(page, '40 opponents', 800);
    const players = page.getByRole('grid').first();
    await shot('players', {
      sidebarPlayers: page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Players' }),
      search: page.getByPlaceholder('Name starts with…'),
      playerList: players,
      firstPlayer: players.getByRole('row').nth(1),
    });
    await players.getByRole('row').nth(2).click();
    await page.waitForTimeout(1000);
    await shot('players-profile', {
      playerList: players,
      profile: page.locator('main').getByRole('heading', { level: 2 }).first().locator('xpath=ancestor::section[1]'),
    });

    await reportUnknown(page, 'desktop-setup');
    rec.save();
  } finally {
    await context.close();
  }
}

/* ======================================================= desktop-app - */

/** A screen by its Cmd/Ctrl + 1-7 shortcut (`components/Palette.tsx`). */
async function shortcut(page: Page, digit: number, text: string | RegExp): Promise<void> {
  await page.keyboard.press(`ControlOrMeta+Digit${digit}`);
  await ready(page, text, 700);
}

/** A choice of the open command palette, by its label. */
async function choose(page: Page, label: string | RegExp): Promise<void> {
  await page.getByRole('option', { name: label }).first().click();
  await page.waitForTimeout(500);
}

export async function captureDesktopApp(browser: Browser): Promise<void> {
  const rec = new Recorder('desktop-app');
  const { context, page, names } = await openApp(browser, 'daily', '#/today');
  const shot = async (id: string, targets: Record<string, Target>, options: ShotOptions = {}) => {
    // The pointer off the content (the bottom of the sidebar): no row left hovered.
    await page.mouse.move(4, VIEWPORT.height - 4);
    await take(rec, page, id, targets, { allowNames: names, ...options });
  };
  const nav = page.getByRole('navigation', { name: 'Main' });
  try {
    /* Today: the current session. */
    await ready(page, 'Current session', 800);
    const session = page.locator('section[aria-labelledby="today-session"]');
    await scrollTo(page, session, 16);
    await shot('today-session', {
      session,
      sessionWhen: session.getByText(/^Started /),
      sessionTiles: session.locator('dl').first(),
      result: session.locator('dl').first().locator('div').first(),
      keyStats: session.locator('table').first(),
      allReports: page.getByRole('link', { name: 'All reports' }),
    });
    const pots = session.getByRole('heading', { name: 'Biggest pots' }).locator('xpath=..');
    await scrollTo(page, pots, 16);
    await shot('today-pots', {
      pots,
      potsTable: pots.locator('table'),
      firstPot: pots.locator('tbody tr').first(),
      importSection: page.locator('section[aria-labelledby="today-import"]'),
    });

    /* Hands: chips with counts, saved filters, the replayer beside the list. */
    await shortcut(page, 2, '48,210 hands');
    const toolbar = page.getByRole('toolbar').first();
    const grid = page.getByRole('grid').first();
    await shot('hands-list', {
      sidebarHands: nav.getByRole('link', { name: 'Hands' }),
      count: page.getByText('48,210 hands'),
      filters: toolbar,
      handList: grid,
    });
    const positionChip = toolbar.getByRole('button', { name: /^(Filter: )?Position/ });
    await positionChip.click();
    const positionPopover = page.getByRole('dialog', { name: 'Position' });
    await positionPopover.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shot('hands-chip', {
      positionChip,
      popover: positionPopover,
      firstOption: positionPopover.locator('label, button').first(),
      filters: toolbar,
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const savedChip = toolbar.getByRole('button', { name: /^Saved filters/ });
    await savedChip.click();
    const savedPopover = page.getByRole('dialog', { name: 'Saved filters' });
    await savedPopover.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    const savedItem = savedPopover.getByRole('button', { name: /^Apply .3-bet pots on the button/ });
    await shot('hands-saved', {
      savedChip,
      savedPopover,
      savedItem,
    });
    await savedItem.click();
    await page.waitForTimeout(800);
    const firstRow = grid.locator('[data-key]').first();
    await shot('hands-filtered', {
      filters: toolbar,
      positionChip: toolbar.getByRole('button', { name: /^(Filter: )?Position/ }),
      potChip: toolbar.getByRole('button', { name: /^(Filter: )?Pot/ }),
      count: page.getByText(/ of 48,210 hands$/),
      handList: grid,
      firstRow,
    });
    await firstRow.click();
    const replayer = page.locator('.rp').first();
    await replayer.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Turn', exact: true }).click();
    await page.waitForTimeout(600);
    const handPanel = page.locator('section[aria-label="Hand"]');
    const addTag = handPanel.locator('input[aria-label="Add a tag"]');
    await addTag.click();
    await addTag.pressSequentially('river-check', { delay: 30 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await shot('hands-replayer', {
      handList: grid,
      selectedRow: firstRow,
      replayer,
      streets: page.getByRole('button', { name: 'Turn', exact: true }).locator('xpath=..'),
      tags: handPanel.locator('ul[aria-labelledby]').first(),
      newTag: handPanel.locator('ul[aria-labelledby] li').filter({ hasText: 'river-check' }),
      note: handPanel.locator('textarea[aria-label="Note"]'),
    });

    /* Reports: one room, so the money adds up. */
    await shortcut(page, 3, 'Winnings');
    await page.waitForTimeout(600);
    const reportsBar = page.getByRole('toolbar').first();
    await reportsBar.getByRole('button', { name: /^Saved filters/ }).click();
    const reportsSaved = page.getByRole('dialog', { name: 'Saved filters' });
    await reportsSaved.waitFor({ state: 'visible' });
    await reportsSaved.getByRole('button', { name: /^Apply .PokerStars only/ }).click();
    await ready(page, '31,540 hands', 900);
    const summary = page.locator('main section').first();
    const graph = page.locator('section[aria-labelledby="reports-graph"]');
    await shot('reports-summary', {
      sidebarReports: nav.getByRole('link', { name: 'Reports' }),
      filters: reportsBar,
      roomChip: reportsBar.getByRole('button', { name: /^(Filter: )?Room/ }),
      summary,
      graph,
    });
    const unit = graph.getByRole('group', { name: 'Show in' });
    await unit.getByRole('button', { name: 'Money' }).click();
    await page.waitForTimeout(700);
    await shot('reports-money', {
      graph,
      unit,
      money: unit.getByRole('button', { name: 'Money' }),
      summary,
    });
    const stats = page.locator('section[aria-labelledby="reports-stats"]');
    await scrollTo(page, stats, 16);
    await shot('reports-stats', {
      stats,
      preflop: stats.locator('table').nth(1),
      statsNote: stats.getByText(/^A value fades while its sample is thin/),
    });
    const breakdown = page.getByRole('heading', { name: 'Breakdown', level: 2 }).locator('xpath=ancestor::section[1]');
    await scrollTo(page, breakdown, 16);
    await shot('reports-breakdown', {
      breakdown,
      tabs: breakdown.getByRole('tablist').first(),
      table: breakdown.locator('table').first(),
    });
    await breakdown.getByRole('tab', { name: 'Starting hands' }).click();
    await page.waitForTimeout(700);
    const matrix = breakdown.getByRole('grid', { name: 'Starting hands, thirteen by thirteen' });
    await matrix.getByRole('gridcell', { name: /^AKs:/ }).click();
    await page.waitForTimeout(400);
    await scrollTo(page, breakdown, 16);
    await shot('reports-grid', {
      breakdown,
      startingHands: breakdown.getByRole('tab', { name: 'Starting hands' }),
      colourBy: breakdown.getByRole('group', { name: 'Colour by' }),
      matrix,
      aks: matrix.getByRole('gridcell', { name: /^AKs:/ }),
      aa: matrix.getByRole('gridcell', { name: /^AA:/ }),
    });

    /* Players: the list, a profile, the user's words. */
    await shortcut(page, 4, '40 opponents');
    const players = page.getByRole('grid').first();
    await shot('players-list', {
      sidebarPlayers: nav.getByRole('link', { name: 'Players' }),
      search: page.getByPlaceholder('Name starts with…'),
      playerList: players,
      colourFilter: page.getByRole('button', { name: 'With a note' }).locator('xpath=..'),
    });
    const target = players.getByRole('row').filter({ hasText: 'Pike_Witty527' }).first();
    await target.click();
    await page.waitForTimeout(900);
    const profile = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Pike_Witty527' }) }).last();
    await profile.getByRole('radio', { name: 'Yellow' }).click();
    const label = profile.getByRole('textbox', { name: 'Add a label' }).or(profile.locator('input[aria-label="Add a label"]'));
    await label.first().click();
    await label.first().pressSequentially('calls down', { delay: 30 });
    await page.keyboard.press('Enter');
    const note = profile.locator('textarea[aria-label="Note"]');
    await note.click();
    await note.pressSequentially('Pays off big river bets; rarely bluffs the turn.', { delay: 10 });
    await page.waitForTimeout(1200);
    const words = note.locator('xpath=ancestor::*[.//*[@role="radiogroup"]][1]');
    await scrollTo(page, profile.getByRole('heading', { name: 'Pike_Witty527' }), 16);
    await shot('players-profile', {
      playerList: players,
      profile,
      together: profile.getByText('Hands together').first(),
      handsWith: profile.getByRole('button', { name: /^Hands with this player/ }),
      words,
      colourTag: profile.getByRole('radiogroup'),
      labels: profile.locator('ul').filter({ hasText: 'calls down' }).first(),
      note,
    });
    await profile.getByRole('button', { name: /^Hands with this player/ }).click();
    await ready(page, /of 48,210 hands/, 900);
    const handsBar = page.getByRole('toolbar').first();
    await shot('players-hands', {
      filters: handsBar,
      playerChip: handsBar.getByRole('button', { name: /Pike_Witty527/ }).first(),
      count: page.getByText(/ of 48,210 hands$/),
      handList: page.getByRole('grid').first(),
    });

    /* Analysis: the background run's grades, after the session. */
    await shortcut(page, 5, 'Session review');
    await ready(page, /Every hand is analysed/, 800);
    const status = page.getByRole('status', { name: 'The analysis' });
    await shot('analysis-session', {
      sidebarAnalysis: nav.getByRole('link', { name: 'Analysis' }),
      tabs: page.getByRole('navigation', { name: /./ }).filter({ hasText: 'Top leaks' }),
      status,
      ongoing: page.getByText(/may still be going on, so the last finished one is shown/),
      sessionPicker: page.getByText('Session', { exact: true }).locator('xpath=..'),
      sessionSummary: page.getByText('When', { exact: true }).locator('xpath=ancestor::*[.//*[text()="Big blinds"]][1]'),
    });
    const worst = page.getByRole('heading', { name: 'Worst decisions' }).locator('xpath=ancestor::section[1]');
    await scrollTo(page, worst, 16);
    await shot('analysis-worst', {
      worst,
      firstWorst: worst.locator('li, a').filter({ hasText: 'Blunder' }).first(),
      deviations: page.getByRole('heading', { name: 'Off your preflop charts' }).locator('xpath=ancestor::section[1]'),
    });
    await page.getByRole('link', { name: 'Top leaks' }).click();
    await ready(page, 'Your three biggest leaks', 1200);
    const leaks = page.locator('section[aria-labelledby="top-leaks"]');
    await shot('analysis-leaks', {
      leaks,
      periods: leaks.getByRole('group').first(),
      firstLeak: leaks.getByText(/^#1/).locator('xpath=..'),
      examples: leaks.getByText('Example hands').first().locator('xpath=..'),
    });

    /* The command palette: fuzzy over screens, hands, players, commands. */
    const input = await palette(page, 'pike');
    const list = page.locator('[role="listbox"][aria-label="Command palette"]');
    await page.waitForTimeout(400);
    await shot('palette-player', {
      paletteInput: input,
      paletteList: list,
      playerOption: list.getByRole('option', { name: /Pike_Witty527/ }).first(),
    });
    await input.fill('');
    await input.pressSequentially('2501029384', { delay: 30 });
    await page.waitForTimeout(600);
    await shot('palette-hand', {
      paletteInput: input,
      paletteList: list,
      handOption: list.getByRole('option', { name: /#250102938475/ }).first(),
    });
    await input.fill('');
    await input.pressSequentially('rep', { delay: 30 });
    await page.waitForTimeout(400);
    await shot('palette-fuzzy', {
      paletteInput: input,
      paletteList: list,
      firstOption: list.getByRole('option').first(),
      shortcutHint: list.getByRole('option', { name: /^Reports/ }).first(),
    });

    /* Preferences, from the palette: density, theme, language. */
    await input.fill('');
    await input.pressSequentially('compact', { delay: 30 });
    await page.waitForTimeout(400);
    await shot('palette-command', {
      paletteInput: input,
      paletteList: list,
      compact: list.getByRole('option', { name: /Compact lists and tables/ }),
    });
    await choose(page, /Compact lists and tables/);
    await shortcut(page, 2, /of 48,210 hands|48,210 hands/);
    await shot('prefs-compact', {
      handList: page.getByRole('grid').first(),
      filters: page.getByRole('toolbar').first(),
    });
    await palette(page, 'light');
    await choose(page, /Use the light theme/);
    await page.waitForTimeout(500);
    await shot('prefs-light', {
      handList: page.getByRole('grid').first(),
      sidebar: nav,
    });
    await palette(page, 'croatian');
    await choose(page, /Switch to Croatian/);
    await page.waitForTimeout(600);
    await shortcut(page, 1, /Trenutna sesija|Današnji|Danas/);
    await shot('prefs-croatian', {
      sidebar: page.locator('nav').first(),
      title: page.getByRole('heading', { level: 1 }).first(),
      session: page.locator('section[aria-labelledby="today-session"]'),
    });

    await reportUnknown(page, 'desktop-app');
    rec.save();
  } finally {
    await context.close();
  }
}

/* ============================================================== HUD - */

/** Close whatever popover or menu is open (they all close on Escape). */
async function closePopover(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

/** The pointer's drag, as a mouse does it: a few steps, so the editor's drag (`hud/drag.tsx`) follows. */
async function moveTo(page: Page, target: Locator, steps = 12): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('drag target is not visible');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
  await page.waitForTimeout(250);
}

export async function captureHudScreens(browser: Browser, rec: Recorder): Promise<void> {
  const { context, page, names } = await openApp(browser, 'hud', '#/hud/tables');
  const shot = (id: string, targets: Record<string, Target>, options: ShotOptions = {}) =>
    take(rec, page, id, targets, { allowNames: names, ...options });
  try {
    await ready(page, 'HUD running', 1200);

    /* The header: the HUD's state as a pill, Editor | At the tables. */
    const header = page.locator('main header').first();
    const pill = (text: string) => header.locator('[data-tone]').filter({ hasText: text }).first();
    const views = page.getByRole('group', { name: 'HUD view' });

    /* At the tables: which design each game gets, and the rooms. */
    const card = (format: 'cash' | 'mtt' | 'spin') => page.locator(`section[aria-labelledby="hud-game-${format}"]`);
    const cash = card('cash');
    const rooms = page.getByRole('region', { name: 'Where the HUD may be used' });
    const room = (name: string) => rooms.locator('li').filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) });
    await card('cash').getByRole('img').waitFor({ state: 'visible' });
    await shot('app-hud-tables', {
      header,
      statusPill: pill('HUD running'),
      viewSwitch: views,
      games: cash.locator('xpath=..'),
      cashCard: cash,
      mttCard: card('mtt'),
      spinCard: card('spin'),
      cashPanel: cash.getByRole('img'),
      cashDesign: cash.locator('select'),
      cashRules: cash.getByRole('button', { name: /Rule/ }),
      rooms,
      starsRow: room('PokerStars'),
      winamaxRow: room('Winamax'),
      ggRow: room('GGPoker'),
      weplayRow: room('WePlay'),
      moreRooms: rooms.getByRole('button', { name: /more rooms? not allowed$/ }),
    });

    /* A room's ⋯: its tables, and why a table was left alone. */
    await rooms.getByRole('button', { name: 'GGPoker: more' }).click();
    const ggMenu = page.getByRole('dialog', { name: 'GGPoker: more' });
    await ggMenu.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    const refused = ggMenu.getByRole('list', { name: 'Tables without the HUD' });
    await shot('app-hud-room-menu', {
      ggRow: room('GGPoker'),
      roomMenu: ggMenu,
      refusedList: refused,
      refusedRow: refused.locator('li[data-why="prohibited"]'),
      noOverride: ggMenu.getByText(/^There is no switch to turn the HUD on here/),
      policyLink: ggMenu.getByRole('link', { name: 'The policy of GGPoker, on its own site' }),
      checked: ggMenu.getByText(/^checked /),
    });
    await closePopover(page);

    await rooms.getByRole('button', { name: 'WePlay: more' }).click();
    const weplayMenu = page.getByRole('dialog', { name: 'WePlay: more' });
    await weplayMenu.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shot('app-hud-room-unknown', {
      weplayRow: room('WePlay'),
      roomMenu: weplayMenu,
      unknownRow: weplayMenu.locator('li[data-why="unknown"]'),
    });
    await closePopover(page);

    /* The foot of the rooms: why there is no switch (ⓘ), and the room list in force (⋯). */
    await rooms.getByRole('button', { name: "Why can't I enable the HUD here?" }).click();
    const why = page.getByRole('dialog', { name: "Why can't I enable the HUD here?" });
    await why.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shot('app-hud-rooms-why', {
      rooms,
      whyButton: rooms.getByRole('button', { name: "Why can't I enable the HUD here?" }),
      explain: why,
      unknownIsNo: why.getByText(/unknown counts as no/),
      stricterOnly: why.getByText(/can only switch a room off/),
    });
    await closePopover(page);

    await rooms.getByRole('button', { name: 'The room list' }).click();
    const list = page.getByRole('dialog', { name: 'The room list' });
    await list.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shot('app-hud-room-list', {
      rooms,
      allowedRooms: rooms.locator('li').filter({ hasText: 'Allowed' }).first().locator('xpath=..'),
      listMenu: list,
      checkNow: list.getByRole('button', { name: 'Look for an update now' }),
      listSource: list.getByText(/^Room list:/),
    });
    await closePopover(page);

    /* macOS: the Accessibility permission, asked only when it would find tables. */
    await scene(page, 'hudPermission');
    await ready(page, 'Needs a permission', 600);
    const permission = page.locator('[role="status"]').filter({ hasText: 'Rail needs the Accessibility permission' });
    await permission.getByRole('button', { name: 'What the permission is for' }).click();
    const permissionInfo = page.getByRole('dialog', { name: 'What the permission is for' });
    await permissionInfo.waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shot('app-hud-permission', {
      statusPill: pill('Needs a permission'),
      permissionRow: permission,
      permissionButton: permission.getByRole('button', { name: 'Open System Settings' }),
      permissionInfo,
      permissionWhy: permissionInfo.getByText(/finds a poker table by its window's title/),
      permissionNot: permissionInfo.getByText(/does not record your screen/),
    }, { uiText: ['Fix ›'] });
    await closePopover(page);
    await scene(page, 'hud');
    await ready(page, 'HUD running', 600);

    /* The editor: a design, its panel, the preview, the popup, the statistics. */
    await views.getByRole('button', { name: 'Editor' }).click();
    const picker = page.getByRole('combobox', { name: 'Design', exact: true });
    await picker.waitFor({ state: 'visible' });
    const designBar = page.getByRole('region', { name: 'Design', exact: true });
    const formats = designBar.getByRole('radiogroup', { name: 'Made for' });
    const panelCard = page.getByRole('region', { name: 'Panel', exact: true });
    const grid = panelCard.getByRole('group', { name: /^The panel: / });
    const drawer = page.getByRole('complementary', { name: 'Statistics', exact: true });
    const previewCard = page.getByRole('region', { name: 'Preview', exact: true });
    await ready(page, 'Colour legend', 800);
    await shot('app-hud-editor', {
      viewSwitch: views,
      designBar,
      designPicker: picker,
      formats,
      designMenu: designBar.getByRole('button', { name: 'More for this design' }),
      save: designBar.getByRole('button', { name: 'Save', exact: true }),
      panelCard,
      panelGrid: grid,
      panelOptions: panelCard.getByText('Colours', { exact: true }).locator('xpath=ancestor::div[1]/..'),
      drawer,
      preflopShelf: drawer.getByRole('list', { name: 'Preflop' }),
      previewCard,
    });

    /* The presets: Spin, three-handed, a panel of its own. */
    await picker.selectOption('preset:spin');
    await page.waitForTimeout(500);
    await shot('app-hud-preset-spin', {
      designBar,
      designPicker: picker,
      formats,
      spinFormat: formats.getByRole('radio', { name: 'Spin' }),
      panelGrid: grid,
    });
    await picker.selectOption('preset:cash');
    await page.waitForTimeout(500);

    /* The statistics drawer: what is typed narrows it. */
    const search = drawer.getByRole('searchbox', { name: 'Find a statistic' });
    await search.pressSequentially('steal', { delay: 40 });
    await page.waitForTimeout(300);
    const steal = drawer.getByRole('button', { name: /^Add Steal \(/ });
    await shot('app-hud-panel', {
      panelGrid: grid,
      drawer,
      search,
      stealRow: steal,
      rightEdge: panelCard.getByRole('separator', { name: /^Columns:/ }),
      bottomEdge: panelCard.getByRole('separator', { name: /^Rows:/ }),
    });

    // The drag (pointer events, as a mouse does it): picked up in the drawer,
    // it shows the slots just past the panel's edges; held over the first
    // slot past the bottom edge, it would add a row there. (The slots past
    // the right edge sit under the panel's options, which take the pointer.)
    await moveTo(page, steal, 1);
    await page.mouse.down();
    const stealBox = await steal.boundingBox();
    if (!stealBox) throw new Error('hud: Steal is not visible');
    await page.mouse.move(stealBox.x + stealBox.width / 2 - 20, stealBox.y + stealBox.height / 2, { steps: 4 });
    const box = panelCard.locator('[data-zone="panel"]');
    const past = box.locator('[data-slot="-1"][data-row="2"][data-col="0"]');
    await past.waitFor({ state: 'visible', timeout: 5000 });
    await moveTo(page, past, 16);
    await shot('app-hud-drag', {
      panelGrid: grid,
      panelBox: box,
      dropSlot: past,
      ghost: page.locator('[class*="ghost"]').filter({ hasText: 'Steal' }),
      stealRow: steal,
    });
    await page.mouse.up();
    await page.waitForTimeout(500);

    /* Dropped: a third row, empty slots beside it, and the user's own copy of the preset. */
    const added = grid.getByRole('button', { name: /^Steal, row 3, column 1:/ });
    await added.waitFor({ state: 'visible', timeout: 5000 });
    await shot('app-hud-dropped', {
      panelGrid: grid,
      newCell: added,
      emptySlot: grid.locator('[data-row="2"][data-col="1"]'),
      designPicker: picker,
      unsaved: designBar.locator('[aria-hidden="true"]').filter({ hasText: 'Cash, my copy' }),
      discard: designBar.getByRole('button', { name: 'Discard' }),
      save: designBar.getByRole('button', { name: 'Save', exact: true }),
      placedRow: drawer.getByRole('button', { name: 'Steal, on the panel' }),
    });

    /* The cell's settings, by the cell: decimals, the sample for full colour, its colour limits. */
    await added.click();
    const cellCard = page.getByRole('dialog', { name: 'Steal settings' });
    await cellCard.waitFor({ state: 'visible' });
    await cellCard.getByRole('radiogroup', { name: 'Decimals' }).getByRole('radio', { name: '1', exact: true }).click();
    await cellCard.getByRole('spinbutton', { name: 'Full colour from' }).fill('80');
    await cellCard.getByRole('radio', { name: /^Tighter game/ }).click();
    await cellCard.getByLabel('Try a value').fill('41');
    await page.waitForTimeout(500);
    await shot('app-hud-cell-settings', {
      cellSettings: cellCard,
      newCell: added,
      remove: cellCard.getByRole('button', { name: 'Remove' }),
      decimals: cellCard.getByRole('radiogroup', { name: 'Decimals' }),
      minSample: cellCard.getByRole('group', { name: 'Full colour from' }),
      bands: cellCard.getByRole('radiogroup', { name: 'Colour bands' }),
      tighter: cellCard.getByRole('radio', { name: /^Tighter game/ }),
      tryValue: cellCard.getByLabel('Try a value').locator('xpath=..'),
      stack: cellCard.getByRole('switch', { name: 'Only at some depths' }),
    });

    /* Only at some stack depths: a display that changes with the stack, which some rooms forbid. */
    await cellCard.getByRole('switch', { name: 'Only at some depths' }).check();
    await page.waitForTimeout(400);
    await shot('app-hud-cell-stack', {
      cellSettings: cellCard,
      stack: cellCard.getByRole('switch', { name: 'Only at some depths' }),
      stackRange: cellCard.getByRole('spinbutton', { name: 'From (bb)' }).locator('xpath=..'),
      stackHint: cellCard.getByText(/^The panel then changes with the stack/),
    });
    await cellCard.getByRole('switch', { name: 'Only at some depths' }).uncheck();
    await page.waitForTimeout(300);
    await closePopover(page);

    /* The live preview, under each room's rules. */
    await scrollTo(page, previewCard, 16);
    const table = previewCard.getByRole('group', { name: /^The design at a / });
    await table.waitFor({ state: 'visible' });
    await page.waitForTimeout(600);
    const roomPills = previewCard.getByRole('radiogroup', { name: 'Room' });
    const seatPills = previewCard.getByRole('radiogroup', { name: 'Seats' });
    await shot('app-hud-preview', {
      previewCard,
      previewRoom: roomPills,
      previewSeats: seatPills,
      previewTable: table,
      previewPanel: table.getByRole('button', { name: /^Panel at seat 2:/ }),
      previewVerdict: previewCard.getByText(/^PokerStars: may/),
    });
    await roomPills.getByRole('radio', { name: 'Winamax' }).click();
    await seatPills.getByRole('radio', { name: '9-max' }).click();
    await page.waitForTimeout(800);
    await shot('app-hud-preview-winamax', {
      previewCard,
      previewRoom: roomPills,
      previewSeats: seatPills,
      previewTable: table,
      previewPanel: table.getByRole('button', { name: /^Panel at seat 2:/ }),
    });

    /* The popup's sections, drawn as at the table. */
    const popupCard = page.getByRole('region', { name: 'Popup', exact: true });
    await scrollTo(page, popupCard, 16);
    const sections = popupCard.locator('section[data-zone]');
    await shot('app-hud-popup-editor', {
      popupCard,
      popupHead: popupCard.getByText('Seat 4', { exact: true }).locator('xpath=..'),
      firstSection: sections.first(),
      sectionTitle: sections.first().getByRole('button', { name: /^Rename / }),
    });

    /* Save the copy: it takes the preset's place at cash tables. */
    await scrollTo(page, designBar, 16);
    await designBar.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForFunction(
      () => (document.querySelector('select[aria-label="Design"]') as HTMLSelectElement | null)?.value.startsWith('user:'),
      undefined,
      { timeout: 5000 },
    );
    await page.waitForTimeout(400);
    await shot('app-hud-saved', {
      designBar,
      designPicker: picker,
      save: designBar.getByRole('button', { name: 'Save', exact: true }),
    });

    /* At the tables again: cash tables get the copy, and a rule keeps Winamax on the preset. */
    await views.getByRole('button', { name: 'At the tables' }).click();
    await cash.getByRole('img', { name: 'The panel of Cash, my copy' }).waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await shot('app-hud-assigned', {
      cashCard: cash,
      cashPanel: cash.getByRole('img'),
      cashDesign: cash.locator('select'),
      cashRules: cash.getByRole('button', { name: /Rule/ }),
      mttCard: card('mtt'),
    });
    await cash.getByRole('button', { name: /Rule/ }).click();
    const rules = page.getByRole('dialog', { name: 'Rules: Cash' });
    await rules.waitFor({ state: 'visible' });
    await rules.getByRole('button', { name: '+ Add rule' }).click();
    await rules.getByRole('combobox', { name: 'Room', exact: true }).selectOption('winamax');
    await rules.getByRole('combobox', { name: 'Game', exact: true }).selectOption('cash');
    await rules.getByRole('combobox', { name: 'Design', exact: true }).selectOption('cash');
    await rules.getByRole('button', { name: 'Add', exact: true }).click();
    await cash.getByRole('button', { name: /^1 rule: / }).waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(400);
    await shot('app-hud-rules', {
      cashCard: cash,
      cashRules: cash.getByRole('button', { name: /^1 rule: / }),
      rulesPopover: rules,
      rule: rules.getByRole('combobox', { name: 'Room', exact: true }).locator('xpath=ancestor::div[2]'),
      addRule: rules.getByRole('button', { name: '+ Add rule' }),
    });
    await closePopover(page);

    await reportUnknown(page, 'hud');
  } finally {
    await context.close();
  }

  /* The HUD popup: the app's own small window beside a clicked panel. */
  const popup = await openApp(browser, 'hud', '#/hud-popup', POPUP_VIEWPORT);
  try {
    const pshot = (id: string, targets: Record<string, Target>) =>
      take(rec, popup.page, id, targets, { allowNames: popup.names });
    const p = popup.page;
    await ready(p, 'Hands together', 1000);
    await pshot('app-popup', {
      popup: p.locator('main'),
      header: p.locator('main header'),
      player: p.getByRole('heading', { level: 1 }),
      close: p.getByRole('button', { name: 'Close (Esc)' }),
      facts: p.locator('main dl').first(),
      ownHands: p.getByText('Hands you played only, as this room\'s rules ask.'),
      together: p.getByText('Hands together'),
      result: p.getByText(/^Cash: .* bb over/),
      words: p.locator('section[aria-label="Note"]'),
    });
    const stats = p.getByRole('heading', { name: 'Statistics', level: 2 }).locator('xpath=..');
    await scrollTo(p, stats, 8);
    await pshot('app-popup-stats', {
      stats,
      firstTable: stats.locator('table').first(),
    });
    const foot = p.locator('main footer');
    await p.locator('details summary').filter({ hasText: 'Colours' }).click();
    await scrollTo(p, p.locator('details').filter({ hasText: 'Colours' }), 8);
    await pshot('app-popup-legend', {
      legend: p.locator('details').filter({ hasText: 'Colours' }),
      legendNote: p.getByText(/^What each colour means/),
    });
    await scrollTo(p, p.getByRole('heading', { name: 'By position' }), 8);
    await pshot('app-popup-foot', {
      byPosition: p.getByText(/^Not shown at Winamax tables/),
      openInApp: p.getByRole('button', { name: 'Open in Rail' }),
      historical: foot.getByText(/^Statistics from past hands only/),
    });
    await reportUnknown(p, 'hud popup');
  } finally {
    await popup.context.close();
  }
}
