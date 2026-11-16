/**
 * A statistic against its target range: the definition's "normal" colour
 * band (`config/stats/`) as a range, how far a value sits from its middle,
 * the colour that distance gets and the strip a card draws under the value.
 * Shared by the desktop app's Live tiles and an opponent's profile cards
 * (`StatCards.tsx`). Nothing here computes a statistic: the value and its
 * band (`Shown.tone`) come from the store, the range from the definition.
 */
import type { StatDefinition, StatTone } from "../model/stats";

/** A range's two ends; `null` where the band is open on that side. */
export interface TargetRange {
  low: number | null;
  high: number | null;
}

/**
 * The definition's "normal" band as a range: from the band before it (its
 * `below`) to its own `below`. Only for a percentage or a ratio (AF) - a
 * win rate's bands are not a target - and `null` when the definition has no
 * such band.
 */
export function targetRange(definition: Pick<StatDefinition, "bands" | "format">): TargetRange | null {
  if (definition.format.unit !== "percent" && definition.format.unit !== "ratio") return null;
  const index = definition.bands.findIndex((band) => band.tone === "normal");
  if (index < 0) return null;
  const low = index > 0 ? (definition.bands[index - 1]?.below ?? null) : null;
  const high = definition.bands[index]?.below ?? null;
  return low === null && high === null ? null : { low, high };
}

/** Where a value's band puts it against the target: below, in range or above. */
export function placeOf(tone: StatTone | null): "below" | "inRange" | "above" | null {
  switch (tone) {
    case "very-low":
    case "low":
      return "below";
    case "normal":
      return "inRange";
    case "high":
    case "very-high":
      return "above";
    default:
      return null;
  }
}

/**
 * How far a value sits from the middle of its target range, in half the
 * range's width: 0 in the middle, 1 at either end, 3 well outside. A range
 * open on one side counts every value on that side as in the middle, and
 * takes a quarter of its one end as the half-width beyond it.
 */
export function rangeScore(value: number, range: TargetRange): number {
  const { low, high } = range;
  if (low !== null && high !== null) {
    const half = (high - low) / 2;
    return half > 0 ? Math.abs(value - (low + high) / 2) / half : 0;
  }
  const edge = (low ?? high) as number;
  const half = Math.max(1, Math.abs(edge) * 0.25);
  if (low === null) return value <= edge ? 0 : 1 + (value - edge) / half;
  return value >= edge ? 0 : 1 + (edge - value) / half;
}

/**
 * The colour of a value `score` half-widths from the middle of its range
 * (the owner's brief, 2026-11-05): the profit colour in the middle, a little
 * warmer at the range's ends, through the warning colour to the loss colour
 * three half-widths out. Tokens only, mixed by the browser, so both themes
 * get their own shades.
 */
export function rangeColour(score: number): string {
  const s = Math.max(0, Math.min(3, score));
  const pct = (value: number) => `${Math.round(value)}%`;
  if (s <= 1) return `color-mix(in oklab, var(--profit-fg) ${pct(100 - 30 * s)}, var(--warning-fg))`;
  if (s <= 1.6) return `color-mix(in oklab, var(--profit-fg) ${pct((70 * (1.6 - s)) / 0.6)}, var(--warning-fg))`;
  return `color-mix(in oklab, var(--warning-fg) ${pct(100 - ((s - 1.6) / 1.4) * 100)}, var(--loss-fg))`;
}

/** Where a tile's strip draws the target band and the value, in percent of its width. */
export interface RangeBar {
  bandLeft: number;
  bandRight: number;
  mark: number;
}

/**
 * The strip under a statistic: its target band in a window two band-widths
 * wider on each side, and the value's mark in it (kept just inside the ends).
 */
export function rangeBar(value: number, range: TargetRange): RangeBar {
  const { low, high } = range;
  const half = low !== null && high !== null ? (high - low) / 2 : Math.max(1, Math.abs((low ?? high) as number) * 0.25);
  const from = (low ?? (high as number) - 2 * half) - 2 * half;
  const to = (high ?? (low as number) + 2 * half) + 2 * half;
  const at = (x: number) => Math.max(2, Math.min(98, ((x - from) / (to - from)) * 100));
  return {
    bandLeft: low === null ? 0 : at(low),
    bandRight: high === null ? 0 : 100 - at(high),
    mark: at(value),
  };
}
