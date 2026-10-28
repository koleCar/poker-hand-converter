// The web app (`web/`, Next.js) on its own port, against the tutorials'
// stack, with every environment variable passed explicitly - never the
// production `web/.env.local` of the main checkout. Next.js would read
// `.env*` files in `web/`, so the dev server is refused when one exists.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO, TURNSTILE_TEST_SITE_KEY, WEB_PORT, WEB_URL, stackEnv } from './paths.ts';

const WEB = join(REPO, 'web');
const START_TIMEOUT_MS = 180_000;

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return response.status < 500;
  } catch {
    return false;
  }
}

export function webEnv(): Record<string, string> {
  const stack = stackEnv();
  return {
    NEXT_PUBLIC_SUPABASE_URL: stack.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: stack.ANON_KEY,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
    NEXT_PUBLIC_AUTH_GOOGLE: 'off',
    NEXT_PUBLIC_SITE_URL: WEB_URL,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

/**
 * Start `next dev` on WEB_PORT unless something of ours already answers
 * there (a server left from `npm run demo-data`); resolves with a stop
 * function (a no-op for a server this call did not start).
 */
export async function startWebServer(): Promise<() => Promise<void>> {
  // The files Next.js loads (`.env.example` is only a template).
  const envFiles = readdirSync(WEB).filter((f) => /^\.env(\.(local|development|development\.local))?$/.test(f));
  if (envFiles.length) {
    throw new Error(`web/ has ${envFiles.join(', ')}: Next.js would read it. Run from a checkout without one.`);
  }
  if (!existsSync(join(WEB, 'node_modules', '.bin', 'next'))) {
    throw new Error('web/ has no node_modules: run `npm ci` in web/ first.');
  }
  if (await answers(WEB_URL)) {
    console.log(`web: reusing the server on ${WEB_URL}`);
    return async () => {};
  }
  // `npm run dev` also writes /sites.json and the legal pages first.
  const child: ChildProcess = spawn('npm', ['run', 'dev', '--', '--port', String(WEB_PORT)], {
    cwd: WEB,
    env: { ...process.env, ...webEnv(), BROWSER: 'none', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-6000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  const stop = async () => {
    if (exited || child.pid === undefined) return;
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    process.kill(-child.pid, 'SIGTERM');
    const timer = setTimeout(() => child.pid !== undefined && process.kill(-child.pid, 'SIGKILL'), 8000);
    await gone;
    clearTimeout(timer);
  };
  const started = Date.now();
  while (!(await answers(WEB_URL))) {
    if (exited) throw new Error(`next dev exited:\n${output}`);
    if (Date.now() - started > START_TIMEOUT_MS) {
      await stop();
      throw new Error(`next dev did not answer on ${WEB_URL}:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`web: next dev on ${WEB_URL}`);
  return stop;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // `node capture/lib/web.ts`: run the dev server in the foreground.
  const stop = await startWebServer();
  console.log('Ctrl-C to stop.');
  process.on('SIGINT', () => void stop().then(() => process.exit(0)));
}
