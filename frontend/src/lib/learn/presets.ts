/**
 * Ranges and boards the interactive examples start from.
 *
 * **Illustrative ranges, written by hand** for teaching: roughly what a
 * reasonable player does from each seat at 100bb, not solved, not copied from
 * any chart or product, and labelled on screen as an illustration. They only
 * have to show *direction* — a button open beats a big-blind call on `K-7-2`,
 * the caller catches up on `8-7-6` — which is all a concept page asks of them.
 *
 * They are deliberately not `lib/analysis/ranges.ts`'s placeholders: those
 * belong to the analysis version and change with it, and a page that teaches
 * what a range is should not move when the grader's stand-in does. They use
 * only the shorthand `parseRange` reads — `+`, same-gap spans like `JJ-22` or
 * `T9s-76s`, and single classes — so every string here parses (pinned by
 * `tests/test/learn.test.ts`).
 */

import { parseRange, type ClassWeights } from "../equity/range";

export const RANGE_TEXT = {
  "open-utg": "66+, A9s+, A5s, A4s, KTs+, QTs+, JTs, T9s, 98s, AJo+, KQo",
  "open-btn": "22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 75s+, 64s+, 54s, A2o+, K8o+, Q9o+, J9o+, T9o, 98o",
  "call-bb":
    "JJ-22, AQs, AJs, ATs, A9s, A8s, A7s, A6s, A5s, A4s, A3s, A2s, K2s+, Q4s+, J6s+, T6s+, 96s+, 85s+, 75s+, 64s+, 54s, 53s, AQo, AJo, ATo, A9o, A8o, A7o, K9o+, Q9o+, J9o+, T8o+, 98o, 87o",
  "call-bb-vs-utg":
    "JJ-22, AQs, AJs, ATs, A9s, A5s, A4s, A3s, A2s, KJs+, KTs, K9s, QTs+, Q9s, JTs, J9s, T9s, T8s, 98s, 97s, 87s, 86s, 76s, 65s, 54s, AQo, AJo, KQo, KJo, QJo",
  "3bet": "TT+, AJs+, AKo, AQo, KQs, A5s, A4s, 76s, 65s",
  "call-3bet": "99-55, AQs, AJs, ATs, KTs+, QTs+, JTs, T9s, 98s, 87s, AQo, KQo",
  "4bet": "KK+, AKs, AKo, A5s, A4s",
} as const;
export type RangeId = keyof typeof RANGE_TEXT;

const cache = new Map<RangeId, ClassWeights>();

export function presetRange(id: RangeId): ClassWeights {
  let range = cache.get(id);
  if (!range) {
    range = parseRange(RANGE_TEXT[id]);
    cache.set(id, range);
  }
  return range;
}

/** One-player ranges for the hand-vs-range equity demo. */
export const RANGE_PRESETS: readonly RangeId[] = ["open-utg", "open-btn", "call-bb", "3bet", "4bet"];

export interface MatchupPreset {
  id: "btn-vs-bb" | "utg-vs-bb" | "3bet-vs-call";
  /** The preflop aggressor: range A. */
  a: RangeId;
  /** The caller: range B. */
  b: RangeId;
}

export const MATCHUP_PRESETS: readonly MatchupPreset[] = [
  { id: "btn-vs-bb", a: "open-btn", b: "call-bb" },
  { id: "utg-vs-bb", a: "open-utg", b: "call-bb-vs-utg" },
  { id: "3bet-vs-call", a: "3bet", b: "call-3bet" },
];

/** Boards worth comparing, each a textbook example of one texture. */
export const BOARD_PRESETS: readonly { id: string; cards: readonly string[] }[] = [
  { id: "k72r", cards: ["Kd", "7c", "2h"] },
  { id: "a83r", cards: ["As", "8d", "3c"] },
  { id: "876tt", cards: ["8h", "7h", "6c"] },
  { id: "jt9mono", cards: ["Js", "Ts", "9s"] },
  { id: "q55", cards: ["Qc", "5d", "5h"] },
  { id: "542", cards: ["5s", "4d", "2c"] },
];

/** Class lists for the combo counter. */
export const COMBO_PRESETS: readonly { id: "premium" | "broadway" | "wheel-aces" | "sets-k72"; classes: readonly string[] }[] = [
  { id: "premium", classes: ["AA", "KK", "QQ", "AKs", "AKo"] },
  { id: "broadway", classes: ["AKs", "AKo", "AQs", "AQo", "KQs", "KQo"] },
  { id: "wheel-aces", classes: ["A5s", "A4s", "A3s", "A2s"] },
  { id: "sets-k72", classes: ["KK", "77", "22"] },
];
