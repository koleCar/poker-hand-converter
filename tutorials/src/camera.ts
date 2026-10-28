// Where the camera looks: a point of the shot (its pixels) and a zoom
// (video pixels per shot pixel). Pure arithmetic, no React.

import type { Box, ShotRecord } from './manifest';
import type { Step } from './scripts/types';

export const WIDTH = 1920;
export const HEIGHT = 1080;
/**
 * The lower third the caption covers: a focus is framed in the space above
 * it, so the caption never hides what the step is about.
 */
export const CAPTION_SPACE = 210;

export interface View {
  cx: number;
  cy: number;
  zoom: number;
}

/** The zoom that shows the shot whole (a screen) or its width (a long page). */
export function baseZoom(shot: Pick<ShotRecord, 'width' | 'height'>): number {
  const contain = Math.min(WIDTH / shot.width, HEIGHT / shot.height);
  if (shot.height / shot.width <= 0.8) return contain;
  // A tall picture: its width, but never past one shot pixel per video
  // pixel (a narrow popup stays its own size).
  return Math.max(contain, Math.min(WIDTH / shot.width, 1));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Keep the view inside the picture (centred where the picture is smaller). */
function contain(shot: ShotRecord, cx: number, cy: number, zoom: number): View {
  const vw = WIDTH / zoom;
  const vh = HEIGHT / zoom;
  return {
    zoom,
    cx: shot.width <= vw ? shot.width / 2 : clamp(cx, vw / 2, shot.width - vw / 2),
    cy: shot.height <= vh ? shot.height / 2 : clamp(cy, vh / 2, shot.height - vh / 2),
  };
}

export function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const b = Math.max(...boxes.map((bx) => bx.y + bx.h));
  return { x, y, w: r - x, h: b - y };
}

export function viewFor(shot: ShotRecord, step: Step): View {
  const base = baseZoom(shot);
  const focus = step.focus ? shot.targets[step.focus] : undefined;
  if (!focus) {
    // The whole shot; a long page from its top.
    return contain(shot, shot.width / 2, HEIGHT / base / 2, base);
  }
  const fill = step.fill ?? 0.6;
  const max = Math.max(base, step.maxZoom ?? 1.35);
  const usable = HEIGHT - CAPTION_SPACE;
  const zoom = clamp(Math.min((fill * WIDTH) / focus.w, (fill * usable) / focus.h), base, max);
  // Centre the focus in the space above the caption.
  const shiftDown = CAPTION_SPACE / 2 / zoom;
  return contain(shot, focus.x + focus.w / 2, focus.y + focus.h / 2 + shiftDown, zoom);
}

/** A shot point in video pixels under a view. */
export function toFrame(view: View, x: number, y: number): { x: number; y: number } {
  return { x: (x - view.cx) * view.zoom + WIDTH / 2, y: (y - view.cy) * view.zoom + HEIGHT / 2 };
}

export function boxToFrame(view: View, box: Box): Box {
  const p = toFrame(view, box.x, box.y);
  return { x: p.x, y: p.y, w: box.w * view.zoom, h: box.h * view.zoom };
}

/** Between two views; zoom in log space so a zoom feels even. */
export function mix(a: View, b: View, t: number): View {
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, zoom };
}
