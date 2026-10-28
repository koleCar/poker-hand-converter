// account: Settings - language, username, posting, the plan, the password,
// downloading your data (run for real, on the demo account) and deleting the
// account (filled in, never submitted) - and the checkout's return page.

import type { Browser } from 'playwright';

import { newContext, open, settle } from '../lib/browser.ts';
import { ACCOUNTS } from '../lib/paths.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('account');
  const context = await newContext(browser, { account: 'demo' });
  // Chrome's native save dialog cannot be driven: the page falls back to
  // its own "Save the file" link, as in browsers without the picker.
  await context.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);

  await open(page, '/');
  await page.locator('.usermenu__trigger').click();
  await page.locator('.usermenu__panel').waitFor();
  await settle(page, 400);
  await rec.shot(page, 'menu', {
    user: '.usermenu__trigger',
    settings: page.getByRole('menuitem', { name: 'Settings' }),
  });
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.waitForURL(/\/settings/);
  await settle(page, 1500);
  const section = (id: string) => page.locator('section', { has: page.locator(`#${id}`) });
  await rec.shot(
    page,
    'settings',
    {
      heading: page.getByRole('heading', { name: 'Settings', level: 1 }),
      language: section('settings-language'),
      username: section('settings-username'),
      posting: section('settings-posting'),
      plan: 'section#plan',
      password: section('settings-password'),
      data: 'section#your-data',
      delete: 'section#delete-account',
    },
    { fullPage: true },
  );

  // Your data: a ZIP built in the browser from your own rows.
  const data = page.locator('section#your-data');
  await data.getByRole('button', { name: 'Download my data' }).click();
  await page.getByText(/Your export is ready/).waitFor({ timeout: 10 * 60_000 });
  await settle(page, 800);
  await rec.shot(
    page,
    'export',
    {
      data,
      options: data.getByRole('checkbox').first(),
      ready: page.getByText(/Your export is ready/),
      save: data.getByRole('link', { name: 'Save the file' }),
    },
    { fullPage: true },
  );

  // Deleting the account: both confirmations filled in; never submitted.
  const del = page.locator('section#delete-account');
  await del.getByLabel(/Type your username/).fill(ACCOUNTS.demo.username);
  await del.getByLabel('Your password').fill('not-the-password');
  await settle(page, 600);
  await rec.shot(
    page,
    'delete',
    {
      del,
      happens: del.getByRole('heading', { name: 'What happens' }),
      first: del.getByRole('link', { name: 'Download your data first' }),
      confirm: del.getByLabel(/Type your username/),
      password: del.getByLabel('Your password'),
      button: del.getByRole('button', { name: 'Delete my account permanently' }),
    },
    { fullPage: true },
  );

  // Coming back from a checkout that was canceled.
  await open(page, '/billing/cancel');
  await rec.shot(page, 'billing-cancel', {
    heading: page.getByRole('heading').first(),
    back: page.getByRole('link', { name: 'Back to your plan' }),
  });
  await context.close();
  rec.save();
}
