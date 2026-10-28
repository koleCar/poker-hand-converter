// The tutorial's body: step after step, the camera moving between targets
// (or cross-fading to the next shot), the pointer travelling and clicking,
// highlights, and the caption.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';

import { HEIGHT, WIDTH, boxToFrame, mix, toFrame, viewFor, type View } from '../camera';
import type { Box, Manifest, ShotRecord } from '../manifest';
import type { Step } from '../scripts/types';
import { EASE_STANDARD, color, font } from '../theme';
import { Caption } from './Caption';
import { ClickRipple, Cursor } from './Cursor';
import { Highlight } from './Highlight';
import { Shot } from './Shot';

export interface TimedStep extends Step {
  chapter: string;
  index: number;
  start: number;
  frames: number;
}

/** Frames of a camera move, of a cross-fade, and the pointer's travel. */
const MOVE = 24;
const FADE = 14;
const POINTER_FROM = 8;
const POINTER_TRAVEL = 26;
const REST = { x: WIDTH * 0.74, y: HEIGHT * 0.78 };

const ease = Easing.bezier(...EASE_STANDARD);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function arrayOf(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function center(b: Box) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** The view during a step: from the previous step's to this one's. */
function viewAt(manifest: Manifest, steps: TimedStep[], i: number, local: number): View {
  const step = steps[i];
  const shot = manifest.shots[step.shot];
  const target = viewFor(shot, step);
  const prev = steps[i - 1];
  const t = ease(clamp01(local / MOVE));
  if (prev && prev.shot === step.shot) return mix(viewFor(shot, prev), target, t);
  // A new picture: settle into place from a touch further out.
  return mix({ ...target, zoom: target.zoom * 0.94 }, target, t);
}

/** Where the pointer is at the end of step `i` (frame pixels), if shown. */
function pointerEnd(manifest: Manifest, steps: TimedStep[], i: number): { x: number; y: number } | null {
  const step = steps[i];
  const shot = manifest.shots[step.shot];
  const box = step.cursor ? shot?.targets[step.cursor] : undefined;
  if (!shot || !box) return null;
  const c = center(box);
  return toFrame(viewFor(shot, step), c.x, c.y);
}

function Missing({ slug, step }: { slug: string; step: Step }) {
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', fontFamily: font.mono, color: color.textSecondary }}>
      <div style={{ fontSize: 34 }}>
        Capture missing: {slug}/{step.shot}
      </div>
      <div style={{ fontSize: 26, marginTop: 16 }}>npm run capture -- {slug}</div>
    </AbsoluteFill>
  );
}

export function Stage({ slug, manifest, steps }: { slug: string; manifest: Manifest | null; steps: TimedStep[] }) {
  const frame = useCurrentFrame();
  const i = Math.max(
    0,
    steps.findIndex((s) => frame >= s.start && frame < s.start + s.frames),
  );
  const step = steps[i];
  const local = frame - step.start;
  const left = step.frames - local;
  const shot: ShotRecord | undefined = manifest?.shots[step.shot];
  const total = steps.length;
  const caption = (
    <Caption text={step.caption} index={step.index} total={total} chapter={step.chapter} age={local} left={i === total - 1 ? left : 99} />
  );
  if (!manifest || !shot) {
    return (
      <AbsoluteFill>
        <Missing slug={slug} step={step} />
        {caption}
      </AbsoluteFill>
    );
  }

  const view = viewAt(manifest, steps, i, local);
  const prev = steps[i - 1];
  const prevShot = prev ? manifest.shots[prev.shot] : undefined;
  const crossFade = prev && prevShot && prev.shot !== step.shot ? clamp01(local / FADE) : 1;

  // The overlay layers: hidden, fading in, or shown.
  const layerOpacity =
    step.layers === false ? 0 : step.reveal ? interpolate(local, [10, 40], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;

  // Highlights come in once the camera has (nearly) arrived.
  const highlightIn = interpolate(local, [MOVE - 8, MOVE + 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const highlightOut = interpolate(left, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const boxes = arrayOf(step.highlight)
    .map((name) => shot.targets[name])
    .filter(Boolean)
    .map((b) => boxToFrame(view, b));

  // The pointer: from where it last was to this step's target.
  let pointer: { x: number; y: number; opacity: number; pressed: number; ripple: number } | null = null;
  const targetBox = step.cursor ? shot.targets[step.cursor] : undefined;
  const from = (prev && pointerEnd(manifest, steps, i - 1)) ?? null;
  if (targetBox) {
    const c = center(targetBox);
    const to = toFrame(view, c.x, c.y);
    const start = from ?? REST;
    const t = ease(clamp01((local - POINTER_FROM) / POINTER_TRAVEL));
    const arrive = POINTER_FROM + POINTER_TRAVEL;
    const pressed = step.click ? interpolate(local - arrive, [0, 3, 9], [0, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 0;
    pointer = {
      x: start.x + (to.x - start.x) * t,
      y: start.y + (to.y - start.y) * t,
      opacity: from ? 1 : clamp01(local / 10),
      pressed,
      ripple: step.click ? local - arrive : -1,
    };
  } else if (from) {
    pointer = { ...from, opacity: 1 - clamp01(local / 8), pressed: 0, ripple: -1 };
  }

  return (
    <AbsoluteFill>
      {crossFade < 1 && prev && prevShot ? <Shot slug={slug} shot={prevShot} view={viewFor(prevShot, prev)} /> : null}
      <Shot slug={slug} shot={shot} view={view} opacity={crossFade} layerOpacity={layerOpacity} />
      <Highlight boxes={boxes} strength={Math.min(highlightIn, highlightOut)} callout={step.callout} />
      {pointer && pointer.ripple >= 0 ? <ClickRipple x={pointer.x} y={pointer.y} age={pointer.ripple} /> : null}
      {pointer && pointer.opacity > 0 ? <Cursor x={pointer.x} y={pointer.y} opacity={pointer.opacity} pressed={pointer.pressed} /> : null}
      {caption}
    </AbsoluteFill>
  );
}
