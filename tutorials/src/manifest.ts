// What the capture wrote (capture/lib/recorder.ts has the writer's copy of
// these types): per shot a PNG, its size, and boxes in its pixels.

import { staticFile } from 'remotion';

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

export function shotUrl(slug: string, file: string): string {
  return staticFile(`captures/${slug}/${file}`);
}

/** The manifest of a tutorial, or null when it has not been captured yet. */
export async function loadManifest(slug: string): Promise<Manifest | null> {
  try {
    const res = await fetch(staticFile(`captures/${slug}/manifest.json`));
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}
