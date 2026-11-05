/**
 * The Live screen's pure helpers: which statistics it shows, a statistic's
 * target range (its definition's "normal" colour band, `config/stats/`),
 * where a value sits against it, and the page buttons of the hands table.
 * Nothing here computes a statistic (guideline §14): the value and its band
 * (`Shown.tone`) come from the store, the range from the definition.
 */
import type { StatDefinition, StatTone } from "@rail/ui/model/stats";

/** The session's statistics, in this order. */
export const LIVE_STATS = [
  "vpip",
  "pfr",
  "three_bet",
  "fold_to_three_bet",
  "cbet_flop",
  "aggression_frequency",
  "wtsd",
  "wsd",
  "bb_per_100",
  "allin_ev_bb_per_100",
] as const;

/** Rows in one page of the hands table. */
export const HANDS_PER_PAGE = 10;

/** Below this the session is too short for a rate per hour. */
export const MIN_MINUTES_FOR_RATE = 10;

/** Whole minutes from one ISO instant to another, never negative. */
export function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

/** A range's two ends; `null` where the band is open on that side. */
export interface TargetRange {
  low: number | null;
  high: number | null;
}

/**
 * The definition's "normal" band as a range: from the band before it (its
 * `below`) to its own `below`. Only for a percentage - a win rate's bands
 * are not a target - and `null` when the definition has no such band.
 */
export function targetRange(definition: Pick<StatDefinition, "bands" | "format">): TargetRange | null {
  if (definition.format.unit !== "percent") return null;
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
 * The page buttons for `total` pages around `current` (1-based): every page
 * when there are seven or fewer, else the first, the last and the current
 * one's neighbours, a gap (`null`) between runs.
 */
export function pageList(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((page) => keep.add(page));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((page) => keep.add(page));
  const pages = [...keep].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  pages.forEach((page, i) => {
    const before = pages[i - 1];
    if (before !== undefined && page - before > 1) out.push(null);
    out.push(page);
  });
  return out;
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

/** A win rate's strip: zero in the middle, ±40 per 100 hands at the ends. */
export function winRateBar(value: number): RangeBar {
  return { bandLeft: 50, bandRight: 0, mark: Math.max(2, Math.min(98, 50 + (Math.max(-40, Math.min(40, value)) / 40) * 48)) };
}

/**
 * The session's result per 100 hands in its money (the toolbar's "$/100"
 * when the graph is in money). The big-blind rate is the `bb_per_100`
 * definition's; money has none, so this one is the session's own result
 * over its hands. `null` without hands.
 */
export function perHundred(amount: number, hands: number): number | null {
  return hands > 0 ? (amount / hands) * 100 : null;
}
