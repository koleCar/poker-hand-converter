// hud: the HUD is drawn natively over a poker client, and these videos never
// record the screen. The real renderer's frames are rendered instead:
// `hud/rail-hud/examples/scene_svg.rs` composes `rail_hud::scene::Scene`s
// (the same layout, colours, restrictions and compliance as the overlays)
// for a few demo tables and writes each as a drawn table plus the overlay,
// as SVG. Here they become PNGs (Inter loaded, at twice the client size),
// the overlay as a layer the video fades in, and the app's HUD screen and
// popup join them (capture/desktop/capture.ts, `captureHudScreens`).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';

import { captureHudScreens } from './desktop/capture.ts';
import { guardNames } from './lib/guard.ts';
import { pngSize, Recorder, type Box } from './lib/recorder.ts';
import { DEMO_DIR, REPO } from './lib/paths.ts';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SceneSeat {
  seat: number;
  name: string;
  hero: boolean;
  archetype: string;
  plate: Rect;
  panel: Rect | null;
  tag: { rect: Rect } | null;
  noteMark: Rect | null;
  label: { rect: Rect } | null;
}

interface SceneState {
  id: string;
  width: number;
  height: number;
  files: { table: string; overlay: string };
  board: Rect;
  seats: SceneSeat[];
  legend: { rect: Rect } | null;
  status: { rect: Rect; text: string } | null;
  refusal: { reason: string; appMessageEn: string } | null;
}

const SCALE = 2;

function box(r: Rect): Box {
  return { x: r.x * SCALE, y: r.y * SCALE, w: r.width * SCALE, h: r.height * SCALE };
}

function fontFace(): string {
  const font = readFileSync(join(REPO, 'web', 'public', 'fonts', 'inter-v4.1-latin.woff2')).toString('base64');
  return `@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 400 800; }`;
}

export async function captureHud(browser: Browser): Promise<void> {
  const rec = new Recorder('hud');
  const svgDir = join(DEMO_DIR, 'hud-svg');
  rmSync(svgDir, { recursive: true, force: true });
  mkdirSync(svgDir, { recursive: true });
  execFileSync('cargo', ['run', '--quiet', '--locked', '-p', 'rail-hud', '--example', 'scene_svg', '--', svgDir], {
    cwd: REPO,
    stdio: 'inherit',
  });
  const scenes = JSON.parse(readFileSync(join(svgDir, 'scenes.json'), 'utf8')) as { states: SceneState[] };

  const context = await browser.newContext({ deviceScaleFactor: SCALE, viewport: { width: 1600, height: 1160 } });
  const page = await context.newPage();
  const face = fontFace();
  const render = async (svgFile: string, out: string, transparent: boolean, size: { width: number; height: number }) => {
    const svg = readFileSync(join(svgDir, svgFile), 'utf8');
    await page.setViewportSize(size);
    await page.setContent(
      `<!doctype html><html><head><style>${face} html,body{margin:0;background:transparent} svg{display:block}</style></head><body>${svg}</body></html>`,
    );
    await page.evaluate(() => document.fonts.ready);
    // The names are the example's made-up ones; checked like any frame.
    await guardNames(page, `hud/${svgFile}`);
    const png = await page.screenshot({ path: join(rec.dir, out), omitBackground: transparent });
    return pngSize(png);
  };

  for (const state of scenes.states) {
    const size = { width: state.width, height: state.height };
    const table = `${state.id}.table.png`;
    const overlay = `${state.id}.overlay.png`;
    const { width, height } = await render(state.files.table, table, false, size);
    await render(state.files.overlay, overlay, true, size);
    const targets: Record<string, Box> = { board: box(state.board) };
    for (const seat of state.seats) {
      const key = seat.hero ? 'hero' : `seat${seat.seat}`;
      targets[`${key}Plate`] = box(seat.plate);
      if (seat.panel) targets[`${key}Panel`] = box(seat.panel);
      if (seat.tag) targets[`${key}Tag`] = box(seat.tag.rect);
      if (seat.noteMark) targets[`${key}Note`] = box(seat.noteMark);
      if (seat.label) targets[`${key}Label`] = box(seat.label.rect);
      targets[`${seat.archetype.replace(/[^a-z]+(.)/g, (_m, c: string) => c.toUpperCase())}Panel`] ??= seat.panel
        ? box(seat.panel)
        : box(seat.plate);
    }
    if (state.legend) targets.legend = box(state.legend.rect);
    if (state.status) targets.status = box(state.status.rect);
    rec.addFile({ id: state.id, file: table, width, height, scale: SCALE, targets, layers: [overlay] });
    console.log(`  hud/${state.id} ${width}x${height} [${Object.keys(targets).join(', ')}]`);
  }
  await context.close();

  await captureHudScreens(browser, rec);
  rec.save();
}
