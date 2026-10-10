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
import type { ClassWeights } from "../equity/range";
import type { PhfHand, Position } from "../phf/types";
import type { StatsContext } from "../stats/context";
import { comboRange, heuristicModel, narrow, removeCards, rangeWeight, streetStrength, type NarrowAction, type NarrowingModel, type NarrowStreet, type StreetStrength } from "./narrowing";
import { populationLine, populationRange } from "./population";
import { chartRange, WALK_RANGE_OPTIONS } from "./preflop";
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
  /** How each preflop range was approximated beyond its source (analysis/18). */
  approx: { hero: RangeApprox[]; villain: RangeApprox[] };
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
  /**
   * A9: the pot was multiway earlier (three or more saw the flop) and became
   * heads-up between these two from the start of `headsUpFrom`. The ranges
   * were narrowed through the multiway streets by `multiway.ts`'s walk;
   * `turnStart` is null unless the turn began heads-up.
   */
  multiway?: { players: number; headsUpFrom: "turn" | "river" };
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

/**
 * How a preflop range was approximated beyond its source (analysis/18):
 * `range-neighbour-depth` a chart range read on a neighbouring depth
 * (`ChartRangeOptions.neighbourDepth`); `range-limp-call` a limper who
 * called an isolation raise, started from the placeholder limp range;
 * (analysis/19) `range-population` an opponent's flat call or limp, started
 * from the population range fitted on shown hands (`population.ts`).
 */
export type RangeApprox = "range-neighbour-depth" | "range-limp-call" | "range-population";

/** What the analysis asks of the preflop ranges beyond the charts (analysis/19). */
export interface PreflopRangeOptions {
  /**
   * The hero's seat: every other seat whose line is a flat call of a single
   * raise or a limp from outside the blinds starts from the population range
   * (`population.ts`, `range-population`). Unset - the trainers - nobody does.
   */
  populationHero?: number;
}

export interface PreflopClassRange {
  range: ClassWeights;
  source: "chart" | "placeholder";
  label: string;
  approx: RangeApprox[];
}

export interface PreflopRange {
  range: Float64Array;
  source: "chart" | "placeholder";
  label: string;
  approx: RangeApprox[];
}

/**
 * Whether a seat other than the blinds limped and then flat-called the raise
 * behind it (the `call` line after a limp): its first voluntary preflop
 * action a call before any raise, its last a call of the first raise.
 */
function limpedThenCalled(context: StatsContext, seat: number, position: Position | null): boolean {
  if (position === "SB" || position === "BB") return false;
  const mine = (context.byStreet.get("preflop") ?? []).filter(
    (decision) => decision.seat === seat && (decision.type === "call" || decision.type === "raise" || decision.type === "bet"),
  );
  if (mine.length < 2) return false;
  const first = mine[0];
  const last = mine[mine.length - 1];
  return first.type === "call" && first.raisesBefore === 0 && last.type === "call" && last.raisesBefore === 1;
}

/**
 * One player's preflop range by class: the charts' for their line (on a
 * neighbouring depth where the answering set has no node,
 * `WALK_RANGE_OPTIONS`), else the labelled placeholder; null with no line. A
 * limper who called an isolation raise starts from the placeholder limp
 * range, not the `call` one (`range-limp-call`, analysis/18: it explains the
 * hands such players show down far better, and better than the limp range
 * times the charts' call frequency there). Since analysis/19, with
 * `options.populationHero`, an opponent's flat call or limp starts from the
 * population range ahead of both (`range-population`; the source stays
 * `placeholder`: not the charts').
 */
export function preflopClassRange(
  hand: PhfHand,
  context: StatsContext,
  seat: number,
  beforeIndex: number,
  charts: ChartSet | null,
  options: PreflopRangeOptions = {},
): PreflopClassRange | null {
  const line = preflopLine(context, seat);
  const position = (context.position.get(seat) ?? null) as Position | null;
  const label = `${line}:${position ?? "?"}`;
  if (options.populationHero !== undefined && seat !== options.populationHero) {
    const population = populationLine(hand, context, seat, beforeIndex);
    if (population) {
      return { range: populationRange(population), source: "placeholder", label: `${population}:${position ?? "?"}`, approx: ["range-population"] };
    }
  }
  const fromCharts = chartRange(hand, seat, beforeIndex, charts, WALK_RANGE_OPTIONS);
  if (fromCharts) return { range: fromCharts.range, source: "chart", label, approx: [...fromCharts.approx] };
  if (line === "unknown") return null;
  if (line === "call" && limpedThenCalled(context, seat, position)) {
    return { range: defaultRange("limp", position).range, source: "placeholder", label: `limp:${position ?? "?"}`, approx: ["range-limp-call"] };
  }
  return { range: defaultRange(line, position).range, source: "placeholder", label, approx: [] };
}

/** One player's preflop range over combos (`preflopClassRange`); null with no line. */
export function preflopRangeOf(
  hand: PhfHand,
  context: StatsContext,
  seat: number,
  beforeIndex: number,
  charts: ChartSet | null,
  options: PreflopRangeOptions = {},
): PreflopRange | null {
  const found = preflopClassRange(hand, context, seat, beforeIndex, charts, options);
  return found ? { ...found, range: comboRange(found.range) } : null;
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
  rangeOptions: PreflopRangeOptions = {},
): RangeWalk | { ok: false; reason: WalkFailure } {
  const seats = flopSeats(context);
  if (seats.length === 0) return { ok: false, reason: "no-flop" };
  if (seats.length !== 2 || !seats.includes(hero) || !seats.includes(villain)) {
    return { ok: false, reason: "multiway-flop" };
  }
  const firstPostflop = hand.actions.find((action) => action.street !== "preflop" && action.street !== "showdown");
  const cut = firstPostflop?.index ?? Number.MAX_SAFE_INTEGER;
  const heroPre = preflopRangeOf(hand, context, hero, cut, charts, rangeOptions);
  const villainPre = preflopRangeOf(hand, context, villain, cut, charts, rangeOptions);
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
          actionIndex: action.index,
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
    approx: { hero: heroPre.approx, villain: villainPre.approx },
    labels: { hero: heroPre.label, villain: villainPre.label },
    model: model.id,
    before: (actionIndex: number) => snapshots.get(actionIndex) ?? null,
    turnStart,
    riverStart,
    preflop,
  };
}
