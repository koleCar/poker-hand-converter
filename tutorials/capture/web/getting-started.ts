// getting-started: the web app signed out (the sign-in dialog the app
// offers by itself), creating an account, signing in, the shell's tabs and
// menu, and the same shell with a library behind it.

import type { Browser } from 'playwright';

import { deleteAccount, ensureAccount, signInSubmit } from '../lib/accounts.ts';
import { newContext, open, settle } from '../lib/browser.ts';
import { ACCOUNTS, DEMO_PASSWORD } from '../lib/paths.ts';
import { Recorder } from '../lib/recorder.ts';

export async function capture(browser: Browser): Promise<void> {
  const rec = new Recorder('getting-started');
  // A brand-new account with nothing in it, made for this video.
  deleteAccount('fresh');
  await ensureAccount('fresh');

  const context = await newContext(browser, { showSignInOffer: true });
  const page = await context.newPage();
  await open(page, '/');
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.waitFor();
  await settle(page, 1500);
  await rec.shot(page, 'offer', {
    dialog: '.authdlg',
    email: dialog.getByLabel('Email'),
    password: dialog.getByLabel('Password'),
    captcha: '.authdlg .captcha',
    submit: '.authdlg__submit',
    create: dialog.getByRole('button', { name: 'Create an account' }),
    guest: '.authdlg__guest',
  });

  // Continue without an account: the converter and the forum work signed out.
  await page.locator('.authdlg__guest').click();
  await settle(page, 800);
  await rec.shot(page, 'guest', {
    tabs: 'nav.shell__tabs',
    forum: page.getByRole('tab', { name: 'Forum' }),
    upload: page.getByRole('tab', { name: 'Upload hand' }),
    learn: page.getByRole('tab', { name: 'Learn' }),
    signIn: '.usermenu__signin',
    feed: 'main',
  });

  // Creating an account: the same dialog in its other mode.
  await page.locator('.usermenu__signin').click();
  const signIn = page.getByRole('dialog', { name: 'Sign in' });
  await signIn.getByRole('button', { name: 'Create an account' }).click();
  const create = page.getByRole('dialog', { name: 'Create an account' });
  await create.waitFor();
  await create.getByLabel('Email').fill('you@example.com');
  await create.getByLabel('Password').fill('a-long-passphrase');
  await settle(page, 1200);
  await rec.shot(page, 'create', {
    dialog: '.authdlg',
    email: create.getByLabel('Email'),
    password: create.getByLabel('Password'),
    submit: '.authdlg__submit',
    back: create.getByRole('button', { name: /Back to sign in/ }),
  });

  // Signing in.
  await create.getByRole('button', { name: /Back to sign in/ }).click();
  const back = page.getByRole('dialog', { name: 'Sign in' });
  await back.getByLabel('Email').fill(ACCOUNTS.fresh.email);
  await back.getByLabel('Password').fill(DEMO_PASSWORD);
  await settle(page, 1500);
  await rec.shot(page, 'sign-in', {
    dialog: '.authdlg',
    email: back.getByLabel('Email'),
    submit: '.authdlg__submit',
    forgot: back.getByRole('button', { name: 'Forgot your password?' }),
  });
  await signInSubmit(page);
  await page.locator('.usermenu__trigger').waitFor({ timeout: 30_000 });
  await settle(page, 1500);
  await rec.shot(page, 'signed-in', {
    tabs: 'nav.shell__tabs',
    upload: page.getByRole('tab', { name: 'Upload hand' }),
    user: '.usermenu__trigger',
    bell: 'a.bell',
    status: '.shell__status',
  });
  await page.locator('.usermenu__trigger').click();
  await page.locator('.usermenu__panel').waitFor();
  await settle(page, 400);
  await rec.shot(page, 'menu', {
    user: '.usermenu__trigger',
    menu: '.usermenu__panel',
    profile: page.getByRole('menuitem', { name: 'Your profile' }),
    settings: page.getByRole('menuitem', { name: 'Settings' }),
    signOut: page.getByRole('menuitem', { name: 'Sign out' }),
  });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Upload hand' }).click();
  await page.waitForURL(/\/convert/);
  await settle(page, 1200);
  await rec.shot(page, 'upload', {
    tab: page.getByRole('tab', { name: 'Upload hand' }),
    drop: '.conv-drop',
    paste: '.single',
  });
  await context.close();

  // With a library: Hand history, Statistics and Analysis join the tabs.
  const demo = await newContext(browser, { account: 'demo' });
  const page2 = await demo.newPage();
  await open(page2, '/');
  await page2.getByRole('tab', { name: 'Hand history' }).waitFor();
  await settle(page2, 1500);
  await rec.shot(page2, 'full-tabs', {
    tabs: 'nav.shell__tabs',
    library: page2.getByRole('tab', { name: 'Hand history' }),
    stats: page2.getByRole('tab', { name: 'Statistics' }),
    analysis: page2.getByRole('tab', { name: 'Analysis' }),
    status: '.shell__status',
    lang: '.langswitch',
    bell: 'a.bell',
  });
  await page2.locator('footer.shell__footer').scrollIntoViewIfNeeded();
  await settle(page2, 600);
  await rec.shot(page2, 'footer', { footer: 'footer.shell__footer' });
  await demo.close();
  rec.save();
}
