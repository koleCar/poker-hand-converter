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
