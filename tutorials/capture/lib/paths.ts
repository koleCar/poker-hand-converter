// Where everything lives. Every generated path below is gitignored
// (`tutorials/.gitignore`): the stack's working copy, the demo data, the
// captures and the videos are regenerated, never committed.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TUTORIALS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO = resolve(TUTORIALS, '..');

/** The isolated Supabase stack's working copy (`npm run stack`). */
export const STACK_DIR = join(TUTORIALS, '.stack');
/** Demo hand files, the demo name set and the scrub list (`npm run demo-data`). */
export const DEMO_DIR = join(TUTORIALS, '.demo');
export const DEMO_HANDS = join(DEMO_DIR, 'hands');
/** Browser sessions of the demo accounts (cookies of the local stack only). */
export const SESSIONS_DIR = join(DEMO_DIR, 'sessions');
/** Screenshots and their manifests, read by the compositions via staticFile(). */
export const CAPTURES = join(TUTORIALS, 'public', 'captures');
export const OUT = join(TUTORIALS, 'out');

/** The stack's project id and ports: 5542x, apart from every other local stack. */
export const PROJECT_ID = 'rail-tutorials';
export const PORTS = {
  api: 55421,
  db: 55422,
  shadow: 55420,
  studio: 55423,
  inbucket: 55424,
  analytics: 55427,
  pooler: 55429,
  inspector: 55428,
} as const;
export const DB_CONTAINER = `supabase_db_${PROJECT_ID}`;

/** The web app's dev server (`next dev`), on its own port. */
export const WEB_PORT = Number(process.env.RAIL_TUTORIAL_WEB_PORT ?? 3100);
export const WEB_URL = `http://localhost:${WEB_PORT}`;
/** The desktop app's Vite dev server, in a plain browser with a mocked IPC. */
export const APP_PORT = Number(process.env.RAIL_TUTORIAL_APP_PORT ?? 1520);
export const APP_URL = `http://localhost:${APP_PORT}`;

/** Cloudflare's published always-passing Turnstile test site key. */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

/** The demo accounts, on the local stack only. */
export const DEMO_PASSWORD = 'rail-demo-password';
export const ACCOUNTS = {
  demo: { email: 'demo@rail.test', username: 'RailDemo' },
  friend: { email: 'friend@rail.test', username: 'GrumpyOtter12' },
  fresh: { email: 'new@rail.test', username: 'LuckyPanda7' },
} as const;
export type AccountKey = keyof typeof ACCOUNTS;

/** The hero's name in every demo hand. */
export const HERO = 'RailDemo';

export interface StackEnv {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

/** The stack's keys, written by `npm run stack` (never committed). */
export function stackEnv(): StackEnv {
  const file = join(STACK_DIR, 'env.json');
  if (!existsSync(file)) {
    throw new Error('No local stack: run `npm run stack` first.');
  }
  return JSON.parse(readFileSync(file, 'utf8')) as StackEnv;
}
