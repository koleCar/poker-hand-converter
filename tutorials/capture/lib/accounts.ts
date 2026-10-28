// The demo accounts, on the tutorials' stack only: created with GoTrue's
// admin API (the stack's local service key), aged and confirmed with psql
// in this stack's own database container, and signed in through the web's
// real sign-in dialog so a capture can reuse the session.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';

import { newContext, open, settle } from './browser.ts';
import { ACCOUNTS, DB_CONTAINER, DEMO_PASSWORD, PORTS, SESSIONS_DIR, stackEnv, type AccountKey } from './paths.ts';

/** Run SQL as postgres in this stack's database container; returns stdout. */
export function psql(sql: string): string {
  const containers = execFileSync('docker', ['ps', '--format', '{{.Names}} {{.Ports}}'], { encoding: 'utf8' });
  const line = containers.split('\n').find((l) => l.startsWith(`${DB_CONTAINER} `));
  if (!line || !line.includes(`:${PORTS.db}->`)) {
    throw new Error(`${DB_CONTAINER} is not running on port ${PORTS.db}: run \`npm run stack\`.`);
  }
  return execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' },
  ).trim();
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  const { API_URL, SERVICE_ROLE_KEY } = stackEnv();
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API_URL)) throw new Error(`not a local stack: ${API_URL}`);
  return fetch(`${API_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
    },
  });
}

export function userId(key: AccountKey): string | null {
  const id = psql(`select id from auth.users where email = ${lit(ACCOUNTS[key].email)};`);
  return id || null;
}

/** Create the account (or reset its password), confirmed and three days old. */
export async function ensureAccount(key: AccountKey): Promise<string> {
  const { email, username } = ACCOUNTS[key];
  let id = userId(key);
  if (!id) {
    const res = await admin('/users', {
      method: 'POST',
      body: JSON.stringify({ email, password: DEMO_PASSWORD, email_confirm: true }),
    });
    if (!res.ok) throw new Error(`creating ${email}: ${res.status} ${await res.text()}`);
    id = ((await res.json()) as { id: string }).id;
  } else {
    const res = await admin(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: DEMO_PASSWORD }) });
    if (!res.ok) throw new Error(`updating ${email}: ${res.status} ${await res.text()}`);
  }
  // Old enough to post (ten minutes) and to vote with weight (a day);
  // confirmed; the username the videos show.
  psql(`
    update auth.users set created_at = now() - interval '3 days', email_confirmed_at = now() - interval '3 days'
      where id = ${lit(id)};
    update public.profiles set created_at = now() - interval '3 days', username = ${lit(username)},
      username_changed_at = now() - interval '40 days'
      where id = ${lit(id)};
  `);
  return id;
}

/** Delete the account and everything it owns (a clean start for a video). */
export function deleteAccount(key: AccountKey): void {
  const { email, username } = ACCOUNTS[key];
  psql(`
    delete from auth.users where email = ${lit(email)};
    delete from public.username_reservations where username_lower = lower(${lit(username)});
  `);
}

/** Sign in through the sign-in dialog and keep the session for the captures. */
export async function signIn(browser: Browser, key: AccountKey): Promise<string> {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const context = await newContext(browser);
  const page = await context.newPage();
  await open(page, '/');
  await page.locator('.usermenu__signin').click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.getByLabel('Email').fill(ACCOUNTS[key].email);
  await dialog.getByLabel('Password').fill(DEMO_PASSWORD);
  await signInSubmit(page);
  await page.locator('.usermenu__trigger').waitFor({ timeout: 30_000 });
  await settle(page);
  const file = join(SESSIONS_DIR, `${key}.json`);
  await context.storageState({ path: file });
  await context.close();
  return file;
}

/** Submit the sign-in dialog once the Turnstile test widget has passed. */
export async function signInSubmit(page: import('playwright').Page): Promise<void> {
  // The test site key passes by itself after a moment; the form refuses to
  // submit before ("Complete the robot check first.").
  await page
    .waitForFunction(
      () => {
        const input = document.querySelector<HTMLInputElement>('.authdlg input[name="cf-turnstile-response"]');
        return !document.querySelector('.authdlg .captcha') || Boolean(input?.value);
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
  await page.locator('.authdlg__submit').click();
}
