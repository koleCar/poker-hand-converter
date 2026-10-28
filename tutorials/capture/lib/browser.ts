// The browser every capture runs in: Playwright's Chromium (the revision
// already in ~/Library/Caches/ms-playwright for the pinned Playwright), a
// 1536 x 864 viewport at device scale 2, so a shot can be zoomed into 2x in
// a 1920 x 1080 video and stay sharp. Dark theme, English, a fixed clock zone.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { SESSIONS_DIR, WEB_URL, type AccountKey } from './paths.ts';

export const VIEWPORT = { width: 1536, height: 864 };
export const SCALE = 2;

/**
 * What a production page would not show: the dev server's indicator, and
 * the line under Cloudflare's *test* Turnstile widget ("For testing only")
 * - the widget is cut to its production height. Nothing else is restyled.
 */
const CAPTURE_CSS = `
  nextjs-portal { display: none !important; }
  .authdlg .captcha { height: 65px; overflow: hidden; }
`;

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface ContextOptions {
  /** Signed in as this demo account (its saved session), or signed out. */
  account?: AccountKey;
  viewport?: { width: number; height: number };
  /** Don't pre-dismiss the automatic sign-in offer (the getting-started tour). */
  showSignInOffer?: boolean;
}

export async function newContext(browser: Browser, options: ContextOptions = {}): Promise<BrowserContext> {
  const state = options.account ? join(SESSIONS_DIR, `${options.account}.json`) : undefined;
  if (state && !existsSync(state)) {
    throw new Error(`No session for ${options.account}: run \`npm run demo-data\` first.`);
  }
  const context = await browser.newContext({
    viewport: options.viewport ?? VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: 'dark',
    locale: 'en-GB',
    timezoneId: 'Europe/Zagreb',
    storageState: state,
    acceptDownloads: true,
  });
  await context.addCookies([{ name: 'rail.locale', value: 'en', url: WEB_URL }]);
  const offer = !options.showSignInOffer;
  await context.addInitScript((dismissOffer: boolean) => {
    try {
      localStorage.setItem('rail.theme', 'dark');
      if (dismissOffer) sessionStorage.setItem('rail.signInOffered', 'yes');
    } catch {
      /* about:blank */
    }
  }, offer);
  await context.addInitScript((css: string) => {
    const add = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.append(style);
    };
    if (document.head) add();
    else document.addEventListener('DOMContentLoaded', add);
  }, CAPTURE_CSS);
  return context;
}

/** Go to a path of the web app and wait for it to settle. */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${WEB_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await settle(page);
}

/** Network idle (Realtime's socket aside) and fonts loaded. */
export async function settle(page: Page, extraMs = 300): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(extraMs);
}
