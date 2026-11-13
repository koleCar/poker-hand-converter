/**
 * "For you": the Trainer dealing from the player's own leaks.
 *
 * The leak finder groups the player's costly decisions into focus areas
 * (`lib/training/plan.ts`, the same areas the study plan picks from), each
 * with the trainer target that practises it. The Trainer works through the
 * areas the sample vouches for, costliest first, {@link HANDS_PER_AREA}
 * hands each, then round again. With no area it can deal (no account, no
 * analysed hands, only turn or multiway leaks), it deals {@link GENERAL}:
 * the spots players most often misplay. Pure.
 */

import type { FocusArea, TrainerTarget } from "../../lib/training/plan";
import { pickFocus } from "../../lib/training/plan";

/** Hands dealt from one area before the next. */
export const HANDS_PER_AREA = 6;
/** At most this many areas in the rotation. */
export const MAX_FOCUS_AREAS = 5;

/** The areas "For you" works through: the surest costliest first, each with a trainer. */
export function trainableAreas(areas: readonly FocusArea[]): FocusArea[] {
  const withTrainer = areas.filter((area) => area.trainer !== null);
  const picked = pickFocus(withTrainer, MAX_FOCUS_AREAS);
  return picked.length > 0 ? picked : withTrainer.slice(0, MAX_FOCUS_AREAS);
}

/**
 * Spots most players lose the most in, for a player with no leaks to read:
 * the big blind's defence, the small blind against the button, facing a
 * 3-bet in position, the in-position c-bet as the raiser, the out-of-position
 * defence on the flop, and river bluff-catching.
 */
export const GENERAL: readonly TrainerTarget[] = [
  { mode: "preflop", family: "vs-open", seat: "BB", vs: "BTN" },
  { mode: "flop", set: "nlhe-cash-6max-100bb", pot: "srp", side: "ip", role: "pfr", seat: null, facing: "check", line: null },
  { mode: "preflop", family: "vs-3bet", seat: "BTN", vs: null },
  { mode: "flop", set: "nlhe-cash-6max-100bb", pot: "srp", side: "oop", role: "caller", seat: "BB", facing: "bet", line: null },
  { mode: "preflop", family: "vs-open", seat: "SB", vs: "BTN" },
  { mode: "river", pot: "srp", side: "ip", role: "any" },
];

/** Which target the `n`th hand of "For you" is dealt from (areas first, else the general list). */
export function focusTarget(areas: readonly FocusArea[], areaIndex: number): { area: FocusArea | null; target: TrainerTarget } {
  if (areas.length > 0) {
    const area = areas[((areaIndex % areas.length) + areas.length) % areas.length];
    return { area, target: area.trainer! };
  }
  return { area: null, target: GENERAL[((areaIndex % GENERAL.length) + GENERAL.length) % GENERAL.length] };
}
