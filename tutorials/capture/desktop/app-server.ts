// The desktop app's window, served by its own Vite dev server on APP_PORT
// (`app/vite.config.ts`, the port given on the command line instead of
// Tauri's 1420): the same React code the app ships, in a plain browser,
// with the IPC mocked (`tauri-mock.ts`). Nothing under `app/` is changed.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { APP_PORT, APP_URL, REPO } from '../lib/paths.ts';

const APP = join(REPO, 'app');
const VITE = join(APP, 'node_modules', '.bin', 'vite');
const START_TIMEOUT_MS = 60_000;

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start the app's Vite server; resolves once it answers, with the function that stops it. */
export async function startAppServer(): Promise<() => Promise<void>> {
  if (!existsSync(VITE)) throw new Error(`No Vite at ${VITE}: run \`npm install\` in app/ first.`);
  if (await answers(APP_URL)) {
    throw new Error(`Something already answers on ${APP_URL}: stop it, or set RAIL_TUTORIAL_APP_PORT.`);
  }
  const child: ChildProcess = spawn(VITE, ['--port', String(APP_PORT), '--strictPort', '--clearScreen', 'false'], {
    cwd: APP,
    env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const stop = async () => {
    if (exited) return;
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await gone;
    clearTimeout(timer);
  };

  const started = Date.now();
  while (!(await answers(APP_URL))) {
    if (exited) throw new Error(`The app's Vite server exited:\n${output}`);
    if (Date.now() - started > START_TIMEOUT_MS) {
      await stop();
      throw new Error(`The app's Vite server did not answer on ${APP_URL} within a minute:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.log(`app: Vite on ${APP_URL}`);
  return stop;
}
