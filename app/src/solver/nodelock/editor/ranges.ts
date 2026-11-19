/**
 * The Ranges step's state (`docs/NODELOCK.md` §9.4): both players' ranges as
 * the flop comes, edited against GTO's, with undo and redo. Pure: no React,
 * no solver; `RangesStep.tsx` draws it and the editor's Solve reads the lock
 * out of it (`rangeEditLocks`).
 *
 * Ranges are 1,326 weights per player (out of position first), the board's
 * combos 0, as `LockSet.ranges` holds them.
 */
import { rangeDiff, rangeLocksOf, rangesDiffer, rangesWith, type RangeLock } from "../engine/door";
import type { RangeShift } from "../contract";

type Pair<T> = [T, T];

export interface RangeEdit {
  /** GTO's ranges: the library chunk's, the reference every change is shown against. */
  gto: Pair<Float64Array>;
  /** The ranges as they are now. */
  ranges: Pair<Float64Array>;
  past: Pair<Float64Array>[];
  future: Pair<Float64Array>[];
}

export type RangeEditAction =
  /** One player's range becomes `weights`; `merge`: the same drag as the last step (no new undo step). */
  | { type: "set"; player: 0 | 1; weights: Float64Array; merge?: boolean }
  /** Back to GTO: one player, or both. */
  | { type: "reset"; player?: 0 | 1 }
  | { type: "undo" }
  | { type: "redo" };

/** The undo steps kept. */
const HISTORY = 100;

/** The editor on GTO's ranges with `locks` in place (the lock being edited, or the chain's, §9.3). */
export function initialRangeEdit(gto: Pair<ArrayLike<number>>, locks: readonly RangeLock[] | null | undefined): RangeEdit {
  const base: Pair<Float64Array> = [Float64Array.from(gto[0]), Float64Array.from(gto[1])];
  return { gto: base, ranges: rangesWith(base, locks), past: [], future: [] };
}

function step(state: RangeEdit, ranges: Pair<Float64Array>, merge = false): RangeEdit {
  const past = merge && state.past.length ? state.past : [...state.past, state.ranges].slice(-HISTORY);
  return { ...state, ranges, past, future: [] };
}

export function rangeEditReducer(state: RangeEdit, action: RangeEditAction): RangeEdit {
  switch (action.type) {
    case "set": {
      const ranges: Pair<Float64Array> = [state.ranges[0], state.ranges[1]];
      ranges[action.player] = action.weights;
      return step(state, ranges, action.merge);
    }
    case "reset": {
      const ranges: Pair<Float64Array> = [state.ranges[0], state.ranges[1]];
      for (const p of action.player === undefined ? ([0, 1] as const) : [action.player]) ranges[p] = Float64Array.from(state.gto[p]);
      return step(state, ranges);
    }
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return { ...state, ranges: previous, past: state.past.slice(0, -1), future: [state.ranges, ...state.future] };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { ...state, ranges: next, past: [...state.past, state.ranges], future: rest };
    }
  }
  return state;
}

/** A player's range differs from GTO's on a live combo. */
export function rangeChanged(state: RangeEdit, player: 0 | 1, board: readonly number[]): boolean {
  return rangesDiffer(state.gto[player], state.ranges[player], board);
}

/** The lock's `ranges` (canonical, only the changed players), or undefined when both are GTO's. */
export function rangeEditLocks(state: RangeEdit, board: readonly number[]): RangeLock[] | undefined {
  return rangeLocksOf(state.gto, state.ranges, board);
}

/** The summary's `ranges` (§9.3): each changed player's share before and after, combos added and removed. */
export function rangeShifts(state: RangeEdit, board: readonly number[], positions: Pair<string>): RangeShift[] | undefined {
  const out: RangeShift[] = [];
  for (const p of [0, 1] as const) {
    if (!rangeChanged(state, p, board)) continue;
    const diff = rangeDiff(state.gto[p], state.ranges[p], board);
    out.push({ position: positions[p], gto: diff.gto.share, locked: diff.edited.share, added: diff.added, removed: diff.removed });
  }
  return out.length ? out : undefined;
}

/** The shift as "BB +7 %": percentage points of the live combos, signed, whole above 1 pp. */
export function shiftPp(shift: Pick<RangeShift, "gto" | "locked">): number {
  const pp = (shift.locked - shift.gto) * 100;
  return Math.abs(pp) >= 1 ? Math.round(pp) : Math.round(pp * 10) / 10;
}

/** "Ranges: BB +7%, BTN −3%": a lock's changed ranges as the first step of its lineage (§9.3); null without any. */
export function rangesLineage(
  list: readonly Pick<RangeShift, "position" | "gto" | "locked">[] | null | undefined,
  words: { shift: (position: string, pp: number) => string; lineage: (shifts: string) => string },
): string | null {
  if (!list?.length) return null;
  return words.lineage(list.map((x) => words.shift(x.position, shiftPp(x))).join(", "));
}
