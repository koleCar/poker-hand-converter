// One tutorial's captures: a PNG per shot and the boxes of the elements the
// video points at, collected into `public/captures/<slug>/manifest.json`,
// which the composition reads (src/manifest.ts has the same types).
//
// Boxes are in the PNG's pixels (CSS pixels times the device scale), so the
// compositions never need to know the viewport the shot was taken at.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';

import { guardNames, type GuardOptions } from './guard.ts';
import { CAPTURES } from './paths.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ShotRecord {
  file: string;
  width: number;
  height: number;
  /** Device pixels per CSS pixel the shot was taken at. */
  scale: number;
  targets: Record<string, Box>;
  /** Pictures drawn over the shot, the same size (the HUD's overlay). */
  layers?: string[];
}

export interface Manifest {
  slug: string;
  capturedAt: string;
  shots: Record<string, ShotRecord>;
}

/** A target: a selector, a locator, or a box in CSS pixels. */
export type Target = string | Locator | { x: number; y: number; w: number; h: number };

export interface ShotOptions extends GuardOptions {
  /** The whole scrollable page (the video pans over it), else the viewport. */
  fullPage?: boolean;
  /** Cut the full page at this many CSS pixels (very long pages). */
  maxHeight?: number;
  /** Clip to this element (the shot is its box). */
  clip?: Locator;
  /** Wait this long first, for animations to settle. */
  settleMs?: number;
}

export class Recorder {
  readonly slug: string;
  readonly dir: string;
  private manifest: Manifest;

  constructor(slug: string) {
    this.slug = slug;
    this.dir = join(CAPTURES, slug);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.manifest = { slug, capturedAt: new Date().toISOString(), shots: {} };
  }

  /**
   * Screenshot `page` as shot `id`, with the boxes of `targets`. A target
   * that is missing fails the capture: a video must not point at nothing.
   */
  async shot(page: Page, id: string, targets: Record<string, Target> = {}, options: ShotOptions = {}): Promise<void> {
    if (this.manifest.shots[id]) throw new Error(`${this.slug}: shot ${id} taken twice`);
    if (options.settleMs) await page.waitForTimeout(options.settleMs);
    await guardNames(page, `${this.slug}/${id}`, options);
    // A whole page is taken from its top: a sticky header stays at the top.
    if (options.fullPage && !options.clip) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
    }
    const scale = await page.evaluate(() => window.devicePixelRatio);
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    let origin = { x: 0, y: 0 };
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (options.clip) {
      const box = await options.clip.boundingBox();
      if (!box) throw new Error(`${this.slug}/${id}: the clip element is not visible`);
      clip = { x: box.x, y: box.y, width: box.width, height: box.height };
      origin = { x: box.x, y: box.y };
    } else if (options.fullPage) {
      // Boxes are relative to the document, not the viewport.
      origin = { x: -scroll.x, y: -scroll.y };
      if (options.maxHeight) {
        const size = await page.evaluate(() => ({
          w: document.documentElement.clientWidth,
          h: document.documentElement.scrollHeight,
        }));
        clip = { x: 0, y: 0, width: size.w, height: Math.min(size.h, options.maxHeight) };
      }
    }
    const boxes: Record<string, Box> = {};
    for (const [name, target] of Object.entries(targets)) {
      let box: { x: number; y: number; width: number; height: number } | null;
      if (typeof target === 'string') box = await page.locator(target).first().boundingBox();
      else if ('boundingBox' in target) box = await target.first().boundingBox();
      else box = { x: target.x, y: target.y, width: target.w, height: target.h };
      if (!box) throw new Error(`${this.slug}/${id}: target ${name} is not visible`);
      boxes[name] = {
        x: Math.round((box.x - origin.x) * scale),
        y: Math.round((box.y - origin.y) * scale),
        w: Math.round(box.width * scale),
        h: Math.round(box.height * scale),
      };
    }
    const file = `${id}.png`;
    const png = await page.screenshot({
      path: join(this.dir, file),
      fullPage: Boolean(options.fullPage) && !options.clip,
      clip,
      animations: 'disabled',
      caret: 'hide',
    });
    const { width, height } = pngSize(png);
    // A target partly outside the picture (a long list cut at maxHeight) is
    // cut to it; one wholly outside is a capture error.
    for (const [name, b] of Object.entries(boxes)) {
      const x = Math.max(0, b.x);
      const y = Math.max(0, b.y);
      const r = Math.min(width, b.x + b.w);
      const bottom = Math.min(height, b.y + b.h);
      if (r - x < 4 || bottom - y < 4) throw new Error(`${this.slug}/${id}: target ${name} is outside the shot`);
      boxes[name] = { x, y, w: r - x, h: bottom - y };
    }
    this.manifest.shots[id] = { file, width, height, scale, targets: boxes };
    console.log(`  ${this.slug}/${id} ${width}x${height} [${Object.keys(boxes).join(', ')}]`);
  }

  /** Add a picture made elsewhere (the HUD's scenes) to the manifest. */
  addFile(record: ShotRecord & { id: string }): void {
    const { id, ...shot } = record;
    if (this.manifest.shots[id]) throw new Error(`${this.slug}: shot ${id} taken twice`);
    this.manifest.shots[id] = shot;
  }

  save(): void {
    writeFileSync(join(this.dir, 'manifest.json'), `${JSON.stringify(this.manifest, null, 2)}\n`);
    console.log(`${this.slug}: ${Object.keys(this.manifest.shots).length} shots -> ${this.dir}`);
  }
}

/** A PNG's size from its IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
