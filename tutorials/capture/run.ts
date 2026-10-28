// `npm run capture [-- slug ...]`: drive the real UI and write each
// tutorial's screenshots and manifest into public/captures/<slug>/.
//
// Needs the tutorials' stack (`npm run stack`) and its demo data
// (`npm run demo-data`). Starts the web's dev server and the desktop app's
// Vite server as needed (and stops them), one headless Chromium for all.
// Every shot passes the name guard first (capture/lib/guard.ts); then every
// target must lie inside its shot.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';

import { startAppServer } from './desktop/app-server.ts';
import * as desktop from './desktop/capture.ts';
import { captureHud } from './hud.ts';
import { launch } from './lib/browser.ts';
import { CAPTURES } from './lib/paths.ts';
import type { Manifest } from './lib/recorder.ts';
import { startWebServer } from './lib/web.ts';

type Capture = (browser: Browser) => Promise<void>;

const web = (name: string): Capture => async (browser) => {
  const mod = (await import(`./web/${name}.ts`)) as { capture: Capture };
  await mod.capture(browser);
};

/** Every tutorial, in the order of the series, and what it needs running. */
const CAPTURES_BY_SLUG: Record<string, { run: Capture; web?: boolean; app?: boolean }> = {
  'getting-started': { run: web('getting-started'), web: true },
  convert: { run: web('convert'), web: true },
  library: { run: web('library'), web: true },
  replayer: { run: web('replayer'), web: true },
  stats: { run: web('stats'), web: true },
  players: { run: web('players'), web: true },
  analysis: { run: web('analysis'), web: true },
  'analysis-session': { run: web('analysis-session'), web: true },
  'analysis-leaks': { run: web('analysis-leaks'), web: true },
  'analysis-charts': { run: web('analysis-charts'), web: true },
  learn: { run: web('learn'), web: true },
  community: { run: web('community'), web: true },
  account: { run: web('account'), web: true },
  'desktop-setup': { run: (b) => desktop.captureDesktopSetup(b), app: true },
  'desktop-app': {
    run: async (b) => {
      const capture = (desktop as Record<string, unknown>).captureDesktopApp as Capture | undefined;
      if (!capture) throw new Error('captureDesktopApp is missing from capture/desktop/capture.ts');
      await capture(b);
    },
    app: true,
  },
  hud: { run: captureHud, app: true },
};

const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const unknown = asked.filter((s) => !(s in CAPTURES_BY_SLUG));
if (unknown.length) {
  console.error(`Unknown tutorial(s): ${unknown.join(', ')}. Known: ${Object.keys(CAPTURES_BY_SLUG).join(', ')}`);
  process.exit(2);
}
const slugs = asked.length ? asked : Object.keys(CAPTURES_BY_SLUG);

/** Targets that fall outside their shot: the video would point off the picture. */
function outside(slug: string): string[] {
  const manifest = JSON.parse(readFileSync(join(CAPTURES, slug, 'manifest.json'), 'utf8')) as Manifest;
  const out: string[] = [];
  for (const [id, shot] of Object.entries(manifest.shots)) {
    for (const [name, box] of Object.entries(shot.targets)) {
      if (box.w <= 0 || box.h <= 0 || box.x < -1 || box.y < -1 || box.x + box.w > shot.width + 1 || box.y + box.h > shot.height + 1) {
        out.push(`${slug}/${id}: ${name} ${JSON.stringify(box)}`);
      }
    }
  }
  return out;
}

const stops: (() => Promise<void>)[] = [];
let failed = false;
try {
  if (slugs.some((s) => CAPTURES_BY_SLUG[s].web)) stops.push(await startWebServer());
  if (slugs.some((s) => CAPTURES_BY_SLUG[s].app)) stops.push(await startAppServer());
  const browser = await launch();
  try {
    for (const slug of slugs) {
      console.log(`\n== ${slug}`);
      try {
        await CAPTURES_BY_SLUG[slug].run(browser);
        const off = outside(slug);
        if (off.length) {
          console.error(`Targets outside their shot:\n  ${off.join('\n  ')}`);
          failed = true;
        }
      } catch (err) {
        console.error(`${slug} failed: ${err instanceof Error ? err.message : String(err)}`);
        failed = true;
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const stop of stops.reverse()) await stop();
}
process.exit(failed ? 1 : 0);
