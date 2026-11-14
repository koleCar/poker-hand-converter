/**
 * "For you": the Trainer dealing from the player's own leaks.
 *
 * The leak finder groups the player's costly decisions into focus areas
 * (`lib/training/plan.ts`, the same areas the study plan picks from), each
 * with the trainer target that practises it. The Trainer works through the
 * areas the sample vouches for, costliest first, {@link HANDS_PER_AREA}
 * hands each, then round again. With no area it can deal (no account, no
 * analysed hands, only turn or multiway leaks), it deals {@link GENERAL}:
 * the spots players most often misplay. An area or spot that cannot be dealt
 * yet - a flop with no flop library, a table not transcribed from GTO Wizard
 * yet - is left out ({@link targetDealable}). Pure.
 */

import { FOUR_BET_POT, HEADS_UP_TABLE, THREE_BET_POT } from "../../lib/analysis/leaks";
import type { RiverPot, RiverRole, RiverSeat } from "../../lib/training";
import type { AreaWhere, FocusArea, TrainerTarget } from "../../lib/training/plan";
import { pickFocus } from "../../lib/training/plan";
import { FLOP_LIBRARY_SETS } from "../../lib/analysis/flopLibrary";
import { CHART_SETS } from "../../lib/charts";

/**
 * A turn spot to practise (the study plan has no turn trainer, so its
 * areas carry none): the turn trainer's pot, side and preflop role.
 */
export interface TurnTarget {
  mode: "turn";
  pot: RiverPot;
  side: RiverSeat | "any";
  role: RiverRole | "any";
  /** A heads-up area's set; absent: the 6-max lines. */
  set?: string;
}

export type FocusTarget = TrainerTarget | TurnTarget;

const HEADS_UP_SET = "nlhe-cash-hu-100bb";

/**
 * The turn spot of a turn area, read as the study plan reads a river area
 * (`trainerTarget`): the role and side from its scenario, a spot facing a
 * bet practised in position (the turn trainer's out-of-position hero acts
 * first), its pot; none multiway or in a 4-bet pot (the turn trainer deals
 * neither).
 */
export function turnTarget(where: AreaWhere): TurnTarget | null {
  if (where.street !== "turn" || where.scenario.includes("-mw-") || where.pot === FOUR_BET_POT) return null;
  const facing = where.family === "vs-bet" || where.family === "vs-raise" || /-vs-(bet|raise)$/.test(where.scenario);
  const match = /^(pfr|caller|limped)-(ip|oop)-/.exec(where.scenario);
  const side: RiverSeat | "any" = facing ? "ip" : match ? (match[2] as RiverSeat) : "any";
  const set = where.table === HEADS_UP_TABLE ? { set: HEADS_UP_SET } : {};
  if (match?.[1] === "limped") return { mode: "turn", pot: "limped", side, role: "any", ...set };
  const pot: RiverPot = where.pot === THREE_BET_POT ? "3bp" : "srp";
  return { mode: "turn", pot, side, role: match ? (match[1] as RiverRole) : "any", ...set };
}

/** The target an area is practised with: its own trainer, or a turn area's turn spot. */
export function areaTarget(area: FocusArea): FocusTarget | null {
  return area.trainer ?? turnTarget(area.where);
}

/**
 * Whether a target can be dealt now: a flop target needs a published flop
 * library, a target naming a set (a leak's table) that set transcribed. One
 * that cannot is left out of "For you" rather than dealt on another set.
 */
export function targetDealable(target: FocusTarget): boolean {
  if (target.mode === "flop" && FLOP_LIBRARY_SETS.length === 0) return false;
  const set = "set" in target ? target.set : null;
  return !set || CHART_SETS.some((spec) => spec.id === set);
}

/** Hands dealt from one area before the next. */
export const HANDS_PER_AREA = 6;
/** At most this many areas in the rotation. */
export const MAX_FOCUS_AREAS = 5;

/** The areas "For you" works through: the surest costliest first, each with a trainer. */
export function trainableAreas(areas: readonly FocusArea[]): FocusArea[] {
  const withTrainer = areas.filter((area) => {
    const target = areaTarget(area);
    return target !== null && targetDealable(target);
  });
  const picked = pickFocus(withTrainer, MAX_FOCUS_AREAS);
  return picked.length > 0 ? picked : withTrainer.slice(0, MAX_FOCUS_AREAS);
}

/**
 * Spots most players lose the most in, for a player with no leaks to read:
 * the big blind's defence, the small blind against the button, facing a
 * 3-bet in position, the in-position c-bet as the raiser, the out-of-position
 * defence on the flop, and river bluff-catching.
 */
const ALL_GENERAL: readonly TrainerTarget[] = [
  { mode: "preflop", family: "vs-open", seat: "BB", vs: "BTN" },
  { mode: "flop", set: "nlhe-cash-6max-100bb", pot: "srp", side: "ip", role: "pfr", seat: null, facing: "check", line: null },
  { mode: "preflop", family: "vs-3bet", seat: "BTN", vs: null },
  { mode: "flop", set: "nlhe-cash-6max-100bb", pot: "srp", side: "oop", role: "caller", seat: "BB", facing: "bet", line: null },
  { mode: "preflop", family: "vs-open", seat: "SB", vs: "BTN" },
  { mode: "river", pot: "srp", side: "ip", role: "any" },
];

/** {@link ALL_GENERAL} as far as it can be dealt now (no flop spot while no flop library is published). */
export const GENERAL: readonly TrainerTarget[] = ALL_GENERAL.filter(targetDealable);

/** Which target the `n`th hand of "For you" is dealt from (areas first, else the general list). */
export function focusTarget(areas: readonly FocusArea[], areaIndex: number): { area: FocusArea | null; target: FocusTarget } {
  if (areas.length > 0) {
    const area = areas[((areaIndex % areas.length) + areas.length) % areas.length];
    return { area, target: areaTarget(area)! };
  }
  return { area: null, target: GENERAL[((areaIndex % GENERAL.length) + GENERAL.length) % GENERAL.length] };
}
