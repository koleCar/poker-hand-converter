/**
 * The range walk: both players' ranges at every postflop moment of a
 * heads-up hand (phase A4).
 *
 * ```
 * preflop range (charts, else placeholder) ─▶ flop: board removed, each action narrows (narrowing.ts)
 *                                          ─▶ turn: the turn solve takes it from here (turn.ts, A5a) …
 *                                          ─▶ river: … and hands the river solve its ranges (river.ts)
 * ```
 *
 * The turn and river are narrowed here too, by the same heuristic: for the
 * equity facts of decisions the solver does not grade, for a river whose turn
 * could not be solved, and for the river's sensitivity check.
 *
 * Only heads-up pots: exactly two players saw the flop. A pot that was
 * multiway on the flop has no two-range story to tell, whoever is left by
 * the river, and the walk says so instead of guessing.
 *
 * River actions are narrowed too, with the same heuristic, but only for the
 * equity facts of a river decision the solver could not grade. A graded river
 * decision reads both ranges from the solve itself.
 */

import type { ChartSet } from "../charts";
import type { PhfHand, Position } from "../phf/types";
import type { StatsContext } from "../stats/context";
import { comboRange, heuristicModel, narrow, removeCards, rangeWeight, streetStrength, type NarrowAction, type NarrowingModel, type NarrowStreet, type StreetStrength } from "./narrowing";
import { chartRange } from "./preflop";
import { defaultRange, preflopLine } from "./ranges";
import { toIndices } from "./texture";

/** Why there is no walk. */
export type WalkFailure = "multiway-flop" | "range-unknown" | "range-empty" | "no-flop";

export interface PlayerRanges {
  hero: Float64Array;
  villain: Float64Array;
}

export interface RangeWalk {
  ok: true;
  hero: number;
  villain: number;
  /** Where each preflop range came from. */
  sources: { hero: "chart" | "placeholder"; villain: "chart" | "placeholder" };
  /** `line:position`, e.g. `open:BTN`: what the screen names each range by. */
  labels: { hero: string; villain: string };
  model: string;
  /** Both ranges immediately before the action with this `PhfAction.index`. */
  before(actionIndex: number): PlayerRanges | null;
  /** Both ranges as the turn card came, with the board removed. Null if no turn. */
  turnStart: PlayerRanges | null;
  /** Both ranges as the river card came, with the board removed. Null if no river. */
  riverStart: PlayerRanges | null;
  /** Both preflop ranges, before any board card or postflop action. */
  preflop: PlayerRanges;
}

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const NOT_MONEY = new Set(["collect", "cashout-pay", "cashout-choose", "show", "muck"]);
const POSTFLOP: readonly NarrowStreet[] = ["flop", "turn", "river"];

function boardOf(hand: PhfHand, street: NarrowStreet): number[] {
  const runout = hand.board.runouts[0];
  if (!runout?.flop || runout.flop.length !== 3) return [];
  const codes = [...runout.flop];
  if (street !== "flop") {
    if (!runout.turn) return [];
    codes.push(runout.turn);
  }
  if (street === "river") {
    if (!runout.river) return [];
    codes.push(runout.river);
  }
  return toIndices(codes);
}

/** The seats that saw the flop: dealt in, not folded preflop. */
export function flopSeats(context: StatsContext): number[] {
  if (!context.dealt.has("flop")) return [];
  return context.dealtInSeats.filter((seat) => context.foldedOn.get(seat) !== "preflop");
}

interface PreflopRange {
  range: Float64Array;
  source: "chart" | "placeholder";
  label: string;
}

function preflopRangeOf(
  hand: PhfHand,
  context: StatsContext,
  seat: number,
  beforeIndex: number,
  charts: ChartSet | null,
): PreflopRange | null {
  const line = preflopLine(context, seat);
  const position = (context.position.get(seat) ?? null) as Position | null;
  const label = `${line}:${position ?? "?"}`;
  const fromCharts = chartRange(hand, seat, beforeIndex, charts);
  if (fromCharts) return { range: comboRange(fromCharts.range), source: "chart", label };
  if (line === "unknown") return null;
  return { range: comboRange(defaultRange(line, position).range), source: "placeholder", label };
}

/**
 * Walks a heads-up hand's postflop actions, narrowing both ranges. `hero` and
 * `villain` are the two seats that saw the flop.
 */
export function walkRanges(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  villain: number,
  charts: ChartSet | null,
  model: NarrowingModel = heuristicModel,
): RangeWalk | { ok: false; reason: WalkFailure } {
  const seats = flopSeats(context);
  if (seats.length === 0) return { ok: false, reason: "no-flop" };
  if (seats.length !== 2 || !seats.includes(hero) || !seats.includes(villain)) {
    return { ok: false, reason: "multiway-flop" };
  }
  const firstPostflop = hand.actions.find((action) => action.street !== "preflop" && action.street !== "showdown");
  const cut = firstPostflop?.index ?? Number.MAX_SAFE_INTEGER;
  const heroPre = preflopRangeOf(hand, context, hero, cut, charts);
  const villainPre = preflopRangeOf(hand, context, villain, cut, charts);
  if (!heroPre || !villainPre) return { ok: false, reason: "range-unknown" };

  let ranges: PlayerRanges = { hero: heroPre.range, villain: villainPre.range };
  const preflop = ranges;
  const checks = new Map<number, number>();
  const snapshots = new Map<number, PlayerRanges>();
  let turnStart: PlayerRanges | null = null;
  let riverStart: PlayerRanges | null = null;
  const strengths = new Map<NarrowStreet, StreetStrength>();

  let street: string | null = null;
  let pot = 0;
  let totals = new Map<number, number>();
  let high = 0;
  let empty = false;

  for (const action of hand.actions) {
    if (action.street !== street) {
      street = action.street;
      totals = new Map();
      high = 0;
      if ((POSTFLOP as readonly string[]).includes(street)) {
        const board = boardOf(hand, street as NarrowStreet);
        if (board.length === 0) break;
        ranges = {
          hero: removeCards(Float64Array.from(ranges.hero), board),
          villain: removeCards(Float64Array.from(ranges.villain), board),
        };
        if (rangeWeight(ranges.hero) <= 0 || rangeWeight(ranges.villain) <= 0) {
          empty = true;
          break;
        }
        if (street === "turn") turnStart = ranges;
        if (street === "river") riverStart = ranges;
      }
    }
    if (action.seat === null || NOT_MONEY.has(action.type)) continue;

    const postflop = (POSTFLOP as readonly string[]).includes(action.street);
    if (postflop && DECISIONS.has(action.type) && (action.seat === hero || action.seat === villain)) {
      snapshots.set(action.index, ranges);
      const mine = totals.get(action.seat) ?? 0;
      const toCall = Math.max(0, high - mine);
      let kind: NarrowAction["kind"] | null = null;
      let sizePot: number | null = null;
      if (action.type === "check") {
        kind = "check";
      } else if (action.type === "bet") {
        kind = "bet";
        sizePot = pot > 0 ? action.amount / pot : null;
      } else if (action.type === "raise") {
        kind = "raise";
        const after = mine + action.amount;
        const increment = Math.max(0, after - high);
        sizePot = pot + toCall > 0 ? increment / (pot + toCall) : null;
      } else if (action.type === "call") {
        kind = "call";
        const before = pot - toCall;
        sizePot = before > 0 ? Math.min(toCall, action.amount) / before : null;
      }
      if (kind) {
        const key = action.street as NarrowStreet;
        let strength = strengths.get(key);
        if (!strength) {
          strength = streetStrength(boardOf(hand, key));
          strengths.set(key, strength);
        }
        const actorIsHero = action.seat === hero;
        const input = {
          street: key,
          board: strength.board,
          actor: actorIsHero ? ranges.hero : ranges.villain,
          opponent: actorIsHero ? ranges.villain : ranges.hero,
          action: { kind, sizePot, allIn: action.allIn, checksBefore: checks.get(action.seat) ?? 0 },
          strength,
        };
        const next = narrow(input, model);
        if (kind === "check") checks.set(action.seat, (checks.get(action.seat) ?? 0) + 1);
        ranges = actorIsHero ? { hero: next, villain: ranges.villain } : { hero: ranges.hero, villain: next };
      }
    }

    pot += action.amount;
    if (action.type !== "ante" && action.type !== "bomb-ante" && action.type !== "uncalled") {
      const total = (totals.get(action.seat) ?? 0) + action.amount;
      totals.set(action.seat, total);
      high = Math.max(high, total);
    }
  }
  if (empty) return { ok: false, reason: "range-empty" };

  return {
    ok: true,
    hero,
    villain,
    sources: { hero: heroPre.source, villain: villainPre.source },
    labels: { hero: heroPre.label, villain: villainPre.label },
    model: model.id,
    before: (actionIndex: number) => snapshots.get(actionIndex) ?? null,
    turnStart,
    riverStart,
    preflop,
  };
}
