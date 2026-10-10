/**
 * Multiway postflop analysis (phase A9, `docs/ANALYSIS-PLAN.md` §10).
 *
 * There is no tractable equilibrium solver for three or more players, so a
 * multiway decision gets what can be said honestly, and says which it is:
 *
 * ```
 * walkMultiway ─▶ every player's range through the hand (narrowing.ts, multiway inputs)
 *   ├▶ headsUpWalk: the pot became heads-up at a street's start ─▶ the heads-up solvers, `multiway-history`
 *   ├▶ multiwayFacts: equity against each range and the field, the MDF split, fold equity, outs
 *   ├▶ multiwayFlags: bluffing into a crowd, slowplaying a vulnerable hand, calling off with a dominated draw
 *   ├▶ riverCallEv: a river call against a fold, by showdown EV ─▶ `source: "approx"`
 *   ├▶ flopCallEv: a flop call against a fold, the showdown share realised by FLOP_REALISATION ─▶ `source: "approx"` (analysis/15)
 *   └▶ turnCallEv: a turn call against a fold, the showdown share realised by TURN_REALISATION ─▶ `source: "approx"` (analysis/16)
 * ```
 *
 * **The walk.** Each player who saw the flop starts from their preflop range
 * (the charts', else the placeholder, as heads-up) and is narrowed by each of
 * their own actions with the same `NarrowingModel`. With three or more players
 * live, the actor's strength is against every other live range (the product
 * of the heads-up strengths) and the model's multiway adjustments apply
 * (fewer value bets, far fewer bluffs, the MDF split for calls); with two
 * left it is exactly the heads-up walk. Card removal: every range loses the
 * board's cards, as heads-up; between two opponents' ranges it is ignored by
 * the narrowing and exact in the equities (`equityVsRanges`).
 *
 * **The approximate river call.** On the river nothing is left to come, so
 * against fixed ranges the showdown is exact: calling wins the pot times the
 * hero's share of it, minus the call. What is approximate is who is in the
 * showdown: players who already put in the bet are; players still to answer
 * it call or fold with the narrowing model's call likelihood (each
 * independently; nobody re-raises). Every way they can answer (call or fold
 * each, at most three of them, eight ways) is enumerated with its chance, the
 * callers' ranges narrowed by the call. The grade compares calling with
 * folding only — raising is not modelled — and is capped at Mistake, like
 * every grade resting on narrowed ranges.
 *
 * **The approximate flop call** (`analysis/15`). Two cards are to come, so
 * the showdown share is not what a call wins: a hand facing a flop bet goes
 * on to win its equity times a *realisation factor* - more for sets and
 * draws (implied odds), less for ace-high and weak pairs - measured on the
 * heads-up flop library by position after the call and hand category
 * (`FLOP_REALISATION`). The enumeration of who answers is the river's; each
 * way's share is multiplied by the factor for the hero's category, in
 * position when the hero acts after everyone left in that way. Applying a
 * heads-up factor to the share against several ranges is the assumption;
 * held out on the library the factor's own error is several percent of the
 * pot, so the grade counts only the EV loss beyond `FLOP_MARGIN_POT` of it.
 *
 * **The approximate turn call** (`analysis/16`). The flop's, one street
 * later: one card to come, the factor measured on Rail's own heads-up turn
 * solves (A5a's solver on turns dealt from the flop library,
 * `TURN_REALISATION`), the same categories, its own margin
 * (`TURN_MARGIN_POT`).
 *
 * **Both streets** (since `analysis/17` on the flop too): a call that leaves
 * the hero, or everyone else in a way, all-in ends the betting, and that
 * way's share is realised as it is (no factor); a call or fold facing a
 * re-raise is refused (`multiway-reraise`), the factors having been measured
 * on trees with one raise - unless the call ends the betting in every way,
 * when no factor is used and nothing is left to measure.
 */

import { equityVsRange, type WeightedCombo } from "../equity/range";
import { equityVsRanges } from "../equity/multiway";
import { evaluateMasks, STANDARD } from "../equity/evaluator";
import type { ChartSet } from "../charts";
import type { PhfHand, Position } from "../phf/types";
import type { StatsContext } from "../stats/context";
import { grade, gradeRank, type GradeResult } from "./grading";
import {
  heuristicModel,
  mdfSplit,
  narrow,
  rangeWeight,
  removeCards,
  streetStrength,
  weightedCombos,
  type NarrowAction,
  type NarrowingModel,
  type NarrowInput,
  type NarrowStreet,
  type StreetStrength,
} from "./narrowing";
import { flopSeats, preflopRangeOf, type PlayerRanges, type PreflopRangeOptions, type RangeApprox, type RangeWalk, type WalkFailure } from "./rangeWalk";
import { FLOP_PROFILE, flopBucket } from "./flopLibrary";
import { rakeOf } from "./river";
import { toIndices } from "./texture";
import { TURN_RAISE_CAP } from "./turn";
import type { Approximation, Flag, Grade, MultiwayEv, MultiwayFacts, MultiwayOpponent, SpotFacts } from "./types";
import type { Spot } from "./walk";

/** The multiway model's id suffix: `heuristic/2+mw`. */
export const MULTIWAY_MODEL_SUFFIX = "+mw";
/** At most this many players still to answer the bet for the river EV (2³ = 8 ways). */
export const MAX_RESPONDERS = 3;
/** Combos under this share of a range's heaviest are dropped before the river EV (as the river solve prunes). */
export const EV_PRUNE_SHARE = 0.002;
/** Bluff flag: equity against the field under this on the river, … */
export const BLUFF_EQUITY_RIVER = 0.15;
/** … and under this on the flop and turn (without a strong draw). */
export const BLUFF_EQUITY_DRAWING = 0.2;
/** Slowplay flag: equity against the field at least this when checking, … */
export const SLOWPLAY_EQUITY = 0.5;
/** … and at least this when flat-calling a bet. */
export const SLOWPLAY_CALL_EQUITY = 0.55;
/** A board this volatile or more makes a strong hand vulnerable (`BoardTexture.volatility`). */
export const VULNERABLE_VOLATILITY = 0.25;
/** Calling off: the call is at least this share of the stack behind, or all-in. */
export const CALL_OFF_SHARE = 0.3;
/** Monte Carlo deals for a multiway equity that cannot be enumerated. */
export const FIELD_TRIALS = 6_000;

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const pct = (value: number) => Math.round(value * 100);

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const NOT_MONEY = new Set(["collect", "cashout-pay", "cashout-choose", "show", "muck"]);
const POSTFLOP: readonly NarrowStreet[] = ["flop", "turn", "river"];

export type SeatRanges = ReadonlyMap<number, Float64Array>;

/* ------------------------------------------------------------------ walk - */

export interface MultiWalk {
  ok: true;
  hero: number;
  /** The seats that saw the flop. */
  seats: number[];
  sources: ReadonlyMap<number, "chart" | "placeholder">;
  /** How each preflop range was approximated beyond its source (analysis/18). */
  approx: ReadonlyMap<number, RangeApprox[]>;
  labels: ReadonlyMap<number, string>;
  /** The narrowing model's id with `+mw`. */
  model: string;
  /** Every live player's range immediately before the action with this `PhfAction.index`. */
  before(actionIndex: number): SeatRanges | null;
  /** Live players' ranges as each street's first card came, the board removed. */
  starts: { turn: SeatRanges | null; river: SeatRanges | null };
  preflop: SeatRanges;
}

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

/**
 * Walks a hand that three or more players saw the flop of, narrowing every
 * player's range by their own actions (the module comment). `hero` must be
 * one of them.
 */
export function walkMultiway(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  charts: ChartSet | null,
  model: NarrowingModel = heuristicModel,
  rangeOptions: PreflopRangeOptions = {},
): MultiWalk | { ok: false; reason: WalkFailure } {
  const seats = flopSeats(context);
  if (seats.length === 0) return { ok: false, reason: "no-flop" };
  if (!seats.includes(hero)) return { ok: false, reason: "multiway-flop" };
  const firstPostflop = hand.actions.find((action) => action.street !== "preflop" && action.street !== "showdown");
  const cut = firstPostflop?.index ?? Number.MAX_SAFE_INTEGER;
  const ranges = new Map<number, Float64Array>();
  const sources = new Map<number, "chart" | "placeholder">();
  const approx = new Map<number, RangeApprox[]>();
  const labels = new Map<number, string>();
  for (const seat of seats) {
    const pre = preflopRangeOf(hand, context, seat, cut, charts, rangeOptions);
    if (!pre) return { ok: false, reason: "range-unknown" };
    ranges.set(seat, pre.range);
    sources.set(seat, pre.source);
    approx.set(seat, pre.approx);
    labels.set(seat, pre.label);
  }
  const preflop: SeatRanges = new Map(ranges);
  const live = new Set(seats);
  const checks = new Map<number, number>();
  const snapshots = new Map<number, SeatRanges>();
  const starts: { turn: SeatRanges | null; river: SeatRanges | null } = { turn: null, river: null };
  const strengths = new Map<NarrowStreet, StreetStrength>();

  let street: string | null = null;
  let pot = 0;
  let totals = new Map<number, number>();
  let high = 0;

  for (const action of hand.actions) {
    if (action.street !== street) {
      street = action.street;
      totals = new Map();
      high = 0;
      if ((POSTFLOP as readonly string[]).includes(street)) {
        const board = boardOf(hand, street as NarrowStreet);
        if (board.length === 0) break;
        for (const seat of live) {
          const next = removeCards(Float64Array.from(ranges.get(seat) as Float64Array), board);
          if (rangeWeight(next) <= 0) return { ok: false, reason: "range-empty" };
          ranges.set(seat, next);
        }
        const snapshot = new Map([...live].map((seat) => [seat, ranges.get(seat) as Float64Array]));
        if (street === "turn") starts.turn = snapshot;
        if (street === "river") starts.river = snapshot;
      }
    }
    if (action.seat === null || NOT_MONEY.has(action.type)) continue;

    const postflop = (POSTFLOP as readonly string[]).includes(action.street);
    if (postflop && DECISIONS.has(action.type) && live.has(action.seat)) {
      snapshots.set(action.index, new Map([...live].map((seat) => [seat, ranges.get(seat) as Float64Array])));
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
        sizePot = pot + toCall > 0 ? Math.max(0, after - high) / (pot + toCall) : null;
      } else if (action.type === "call") {
        kind = "call";
        const before = pot - toCall;
        sizePot = before > 0 ? Math.min(toCall, action.amount) / before : null;
      }
      if (action.type === "fold") live.delete(action.seat);
      if (kind) {
        const key = action.street as NarrowStreet;
        let strength = strengths.get(key);
        if (!strength) {
          strength = streetStrength(boardOf(hand, key));
          strengths.set(key, strength);
        }
        const others = [...live].filter((seat) => seat !== action.seat).map((seat) => ranges.get(seat) as Float64Array);
        const input: NarrowInput = {
          street: key,
          board: strength.board,
          actor: ranges.get(action.seat) as Float64Array,
          opponent: others[0] ?? (ranges.get(action.seat) as Float64Array),
          action: { kind, sizePot, allIn: action.allIn, checksBefore: checks.get(action.seat) ?? 0 },
          strength,
          actionIndex: action.index,
        };
        // Heads-up by now: exactly the heads-up walk's input.
        if (others.length >= 2) {
          input.players = others.length + 1;
          input.opponents = others;
        }
        const next = narrow(input, model);
        if (kind === "check") checks.set(action.seat, (checks.get(action.seat) ?? 0) + 1);
        ranges.set(action.seat, next);
      }
    }

    pot += action.amount;
    if (action.type !== "ante" && action.type !== "bomb-ante" && action.type !== "uncalled") {
      const total = (totals.get(action.seat) ?? 0) + action.amount;
      totals.set(action.seat, total);
      high = Math.max(high, total);
    }
  }

  return {
    ok: true,
    hero,
    seats,
    sources,
    approx,
    labels,
    model: `${model.id}${MULTIWAY_MODEL_SUFFIX}`,
    before: (actionIndex) => snapshots.get(actionIndex) ?? null,
    starts,
    preflop,
  };
}

/**
 * The heads-up part of a multiway hand (A9, "heads-up reducible"): when a
 * street began with only the hero and one opponent left, the heads-up
 * solvers take it from there with the ranges the multiway walk narrowed.
 * The turn's start is given only when the turn began heads-up; the river's
 * when the river did. Null when no street after the flop began heads-up.
 */
export function headsUpWalk(multi: MultiWalk): RangeWalk | null {
  const pairOf = (start: SeatRanges | null) =>
    start && start.size === 2 && start.has(multi.hero) ? ([...start.keys()].find((seat) => seat !== multi.hero) ?? null) : null;
  const fromTurn = pairOf(multi.starts.turn);
  const fromRiver = pairOf(multi.starts.river);
  const villain = fromTurn ?? fromRiver;
  if (villain === null) return null;
  const hero = multi.hero;
  const pair = (start: SeatRanges | null): PlayerRanges | null => {
    const a = start?.get(hero);
    const b = start?.get(villain);
    return a && b ? { hero: a, villain: b } : null;
  };
  return {
    ok: true,
    hero,
    villain,
    sources: { hero: multi.sources.get(hero) ?? "placeholder", villain: multi.sources.get(villain) ?? "placeholder" },
    approx: { hero: multi.approx.get(hero) ?? [], villain: multi.approx.get(villain) ?? [] },
    labels: { hero: multi.labels.get(hero) ?? "unknown:?", villain: multi.labels.get(villain) ?? "unknown:?" },
    model: multi.model,
    before: (actionIndex) => pair(multi.before(actionIndex)),
    turnStart: fromTurn !== null ? pair(multi.starts.turn) : null,
    riverStart: pair(multi.starts.river),
    preflop: pair(multi.preflop) as PlayerRanges,
    multiway: { players: multi.seats.length, headsUpFrom: fromTurn !== null ? "turn" : "river" },
  };
}

/* ----------------------------------------------------------- the table - */

export interface SeatAt {
  seat: number;
  /** Chips in on this street before the action, minor units. */
  streetTotal: number;
  /** Stack behind before the action, minor units. */
  behind: number;
  allIn: boolean;
}

export interface TableAt {
  /** The street's highest commitment before the action. */
  high: number;
  /** Live players (not folded) other than the actor, in this street's acting order. */
  opponents: SeatAt[];
  /** The actor's place in the acting order. */
  actorOrder: number;
  /** Each seat's place in this street's acting order. */
  order: ReadonlyMap<number, number>;
}

/**
 * Who is still in, what each has in on the street and behind, and the
 * street's acting order, immediately before the action with `actionIndex`.
 * The acting order is the order seats first act on the street (a seat that
 * never acts on it, being all-in, comes last).
 */
export function tableAt(hand: PhfHand, actionIndex: number): TableAt | null {
  const target = hand.actions.find((action) => action.index === actionIndex);
  if (!target || target.seat === null) return null;
  const actor = target.seat;
  const order = new Map<number, number>();
  for (const action of hand.actions) {
    if (action.street === target.street && action.seat !== null && DECISIONS.has(action.type) && !order.has(action.seat)) {
      order.set(action.seat, order.size);
    }
  }
  const contributed = new Map<number, number>();
  const folded = new Set<number>();
  const allIn = new Set<number>();
  let totals = new Map<number, number>();
  let street: string | null = null;
  let high = 0;
  for (const action of hand.actions) {
    if (action.index === actionIndex) break;
    if (action.street !== street) {
      street = action.street;
      totals = new Map();
      high = 0;
    }
    if (action.seat === null || NOT_MONEY.has(action.type)) continue;
    contributed.set(action.seat, (contributed.get(action.seat) ?? 0) + action.amount);
    if (action.type === "fold") folded.add(action.seat);
    if (action.allIn) allIn.add(action.seat);
    if (action.type !== "ante" && action.type !== "bomb-ante" && action.type !== "uncalled") {
      const total = (totals.get(action.seat) ?? 0) + action.amount;
      totals.set(action.seat, total);
      high = Math.max(high, total);
    }
  }
  const opponents: SeatAt[] = [];
  for (const player of hand.players) {
    const seat = player.seat;
    if (seat === actor || folded.has(seat) || !contributed.has(seat)) continue;
    opponents.push({
      seat,
      streetTotal: totals.get(seat) ?? 0,
      behind: Math.max(0, (player.startingStack ?? 0) - (contributed.get(seat) ?? 0)),
      allIn: allIn.has(seat),
    });
  }
  const rank = (seat: number) => order.get(seat) ?? Number.MAX_SAFE_INTEGER;
  opponents.sort((a, b) => rank(a.seat) - rank(b.seat) || a.seat - b.seat);
  return { high, opponents, actorOrder: rank(actor), order };
}

/* ------------------------------------------------------------ the outs - */

/**
 * The next card (A9 facts): how many of the unseen cards make the hero's hand
 * the nuts — no two cards the opponents could hold beat it on that board —
 * and how many improve it to a straight or better that is still not the
 * nuts: the outs that win small pots and lose big ones (reverse implied odds).
 * Flop and turn only.
 */
export function nextCardOuts(hole: readonly number[], board: readonly number[]): { nut: number; nonNut: number; cards: number } {
  const used = new Uint8Array(52);
  for (const card of [...hole, ...board]) used[card] = 1;
  const masksOf = (cards: readonly number[]) => {
    const m = [0, 0, 0, 0];
    for (const card of cards) m[card & 3] |= 1 << (card >> 2);
    return m;
  };
  const valueOf = (m: number[]) => evaluateMasks(STANDARD, m[0], m[1], m[2], m[3]);
  const now = valueOf(masksOf([...hole, ...board])) >> 20;
  const STRAIGHT_CATEGORY = 4;
  const scratch = new Int32Array(4);
  let nut = 0;
  let nonNut = 0;
  let cards = 0;
  for (let next = 0; next < 52; next += 1) {
    if (used[next]) continue;
    cards += 1;
    const after = [...board, next];
    const boardMasks = masksOf(after);
    const heroValue = valueOf(masksOf([...hole, ...after]));
    used[next] = 1;
    // Is any two-card holding better? Stops at the first one.
    let beaten = false;
    for (let a = 0; a < 52 && !beaten; a += 1) {
      if (used[a]) continue;
      for (let b = a + 1; b < 52; b += 1) {
        if (used[b]) continue;
        scratch[0] = boardMasks[0];
        scratch[1] = boardMasks[1];
        scratch[2] = boardMasks[2];
        scratch[3] = boardMasks[3];
        scratch[a & 3] |= 1 << (a >> 2);
        scratch[b & 3] |= 1 << (b >> 2);
        if (evaluateMasks(STANDARD, scratch[0], scratch[1], scratch[2], scratch[3]) > heroValue) {
          beaten = true;
          break;
        }
      }
    }
    used[next] = 0;
    const category = heroValue >> 20;
    if (!beaten) nut += 1;
    else if (category >= STRAIGHT_CATEGORY && category > now) nonNut += 1;
  }
  return { nut, nonNut, cards };
}

/* ----------------------------------------------------------- the facts - */

/** A range without the hero's cards, pruned of slivers. */
function prepared(range: Float64Array, heroCards: readonly number[], prune = 0): Float64Array {
  const out = removeCards(Float64Array.from(range), heroCards);
  if (prune > 0) {
    let max = 0;
    for (let c = 0; c < out.length; c += 1) max = Math.max(max, out[c]);
    const floor = max * prune;
    for (let c = 0; c < out.length; c += 1) if (out[c] < floor) out[c] = 0;
  }
  return out;
}

/** The share of `range` (weights) that takes a call against a bet of `sizePot`, by `model`, and the calling range. */
export function callShare(
  model: NarrowingModel,
  input: Omit<NarrowInput, "action">,
  sizePot: number,
): { share: number; range: Float64Array } {
  const range = narrow({ ...input, action: { kind: "call", sizePot, allIn: false } }, model);
  const before = rangeWeight(input.actor);
  return { share: before > 0 ? rangeWeight(range) / before : 0, range };
}

export interface MultiwayFactsInput {
  spot: Spot;
  facts: SpotFacts;
  hand: PhfHand;
  context: StatsContext;
  hero: number;
  walk: MultiWalk | null;
  model: NarrowingModel;
  seed: number;
  /** Compute equities (`AnalyzeOptions.equity`). */
  equity: boolean;
}

const STRONG_DRAWS = new Set(["flush-draw", "nut-flush-draw", "oesd"]);

/**
 * The facts of one multiway decision (A9). Equities need the walk; without
 * one (a range that could not be walked) the geometry is still given.
 */
export function multiwayFacts(input: MultiwayFactsInput): MultiwayFacts {
  const { spot, facts, hand, context, hero, walk } = input;
  const table = tableAt(hand, spot.action.index);
  const ranges = walk?.before(spot.action.index) ?? null;
  const heroCodes = facts.holeCards;
  const heroCards = toIndices(heroCodes);
  const board = toIndices(facts.board);
  const live = table?.opponents ?? spot.opponents.map((o) => ({ seat: o.seat, streetTotal: 0, behind: o.behind, allIn: o.allIn }));

  const opponents: MultiwayOpponent[] = [];
  const combosFor: WeightedCombo[][] = [];
  live.forEach((seat, i) => {
    const range = ranges?.get(seat.seat) ?? null;
    let equity: number | null = null;
    let combos = 0;
    if (range) {
      const own = prepared(range, heroCards);
      combos = round1(rangeWeight(own, board));
      const list = weightedCombos(own);
      combosFor.push(list);
      if (input.equity && list.length > 0) {
        try {
          equity = round3(equityVsRange({ hero: heroCodes, range: list, board: facts.board, seed: input.seed + 101 * (i + 1) }).equity);
        } catch {
          equity = null;
        }
      }
    }
    // Still to act after the hero this street: facing a bet, everyone who has
    // not matched it yet; otherwise everyone after the hero in the order.
    const toAct =
      !seat.allIn &&
      table !== null &&
      (spot.toCall > 0 ? seat.streetTotal < table.high : (table.order.get(seat.seat) ?? -1) > table.actorOrder);
    opponents.push({
      position: (context.position.get(seat.seat) ?? null) as Position | null,
      range: walk?.labels.get(seat.seat) ?? "unknown:?",
      source: walk?.sources.get(seat.seat) ?? "placeholder",
      ...(walk?.approx.get(seat.seat)?.length ? { approx: [...(walk.approx.get(seat.seat) as RangeApprox[])] } : {}),
      equity,
      combos,
      toAct,
      allIn: seat.allIn,
    });
  });

  let field: number | null = null;
  let fieldMethod: MultiwayFacts["fieldMethod"] = null;
  if (input.equity && ranges && combosFor.length === live.length && combosFor.every((list) => list.length > 0)) {
    try {
      const result = equityVsRanges({ hero: heroCodes, ranges: combosFor, board: facts.board, seed: input.seed, trials: FIELD_TRIALS });
      field = round3(result.equity);
      fieldMethod = result.method;
    } catch {
      field = null;
    }
  }

  const behind = opponents.filter((o) => o.toAct).length;
  const players = live.length + 1;
  const mdfSplitFact =
    facts.facingPot !== null && facts.facingPot > 0
      ? (() => {
          const defenders = players - 1;
          return {
            mdf: round3(1 / (1 + facts.facingPot)),
            defenders,
            each: round3(mdfSplit(facts.facingPot, defenders)),
          };
        })()
      : null;

  // The hero bet or raised: how often would they all fold, if each folded as
  // often as heads-up against this size (the model's estimate)?
  let foldEquity: MultiwayFacts["foldEquity"] = null;
  const action = spot.decision.type;
  const heroRange = ranges?.get(hero) ?? null;
  if ((action === "bet" || action === "raise") && facts.betPot !== null && facts.betPot > 0 && ranges && heroRange) {
    const street = facts.street as NarrowStreet;
    const strength = streetStrength(board);
    const each: number[] = [];
    for (const seat of live) {
      const range = ranges.get(seat.seat);
      if (!range || seat.allIn) continue;
      const own = prepared(range, heroCards);
      if (rangeWeight(own) <= 0) continue;
      const { share } = callShare(input.model, { street, board, actor: own, opponent: heroRange, strength }, facts.betPot);
      each.push(round3(1 - share));
    }
    if (each.length > 0) {
      const all = each.reduce((product, value) => product * value, 1);
      foldEquity = { needed: round3(facts.betPot / (1 + facts.betPot)), each, all: round3(all) };
    }
  }

  let outs: MultiwayFacts["outs"] = null;
  if ((facts.street === "flop" || facts.street === "turn") && heroCards.length === 2) {
    outs = nextCardOuts(heroCards, board);
  }
  const reverseImplied = outs !== null && players >= 3 && outs.nonNut >= 4 && outs.nonNut > outs.nut;

  // The preflop raiser still to act behind a hero who has not been bet into:
  // checking to the raiser is the normal play, not a slowplay.
  const raiser = context.preflopAggressor;
  const raiserBehind =
    raiser !== null && raiser !== hero && spot.toCall === 0 && live.some((seat, i) => seat.seat === raiser && opponents[i].toAct);

  return {
    players,
    model: walk?.model ?? `${input.model.id}${MULTIWAY_MODEL_SUFFIX}`,
    raiserBehind,
    opponents,
    field,
    fieldMethod,
    behind,
    lastToAct: behind === 0,
    mdfSplit: mdfSplitFact,
    foldEquity,
    outs,
    reverseImplied,
    ev: null,
  };
}

/* ----------------------------------------------------------- the flags - */

const ONE_PAIR_TOP = new Set(["overpair", "top-pair"]);
const STRONG_MADE = new Set(["set", "trips", "two-pair", "straight", "flush", "overpair", "top-pair"]);
/** Flat-calling is a slowplay only with two pair or better: one pair calling a bet multiway is ordinary. */
const STRONG_FOR_RAISE = new Set(["set", "trips", "two-pair", "straight", "flush"]);
const AT_LEAST_TOP_PAIR = new Set([
  "straight-flush",
  "quads",
  "full-house",
  "flush",
  "straight",
  "set",
  "trips",
  "two-pair",
  "overpair",
  "top-pair",
]);

/** The multiway flags (A9) of one decision: notes, the bluff one Inaccurate at its loudest. */
export function multiwayFlags(spot: Spot, facts: SpotFacts, mw: MultiwayFacts): Flag[] {
  const flags: Flag[] = [];
  const action = spot.decision.type;
  const opponents = mw.players - 1;
  const field = mw.field;
  if (opponents < 2 || field === null) return flags;
  const street = facts.street;
  const strongDraw = facts.draws.some((draw) => STRONG_DRAWS.has(draw));

  if ((action === "bet" || action === "raise") && mw.foldEquity) {
    const { needed, all } = mw.foldEquity;
    const weak = street === "river" ? field < BLUFF_EQUITY_RIVER : field < BLUFF_EQUITY_DRAWING && !strongDraw;
    if (weak && all < needed) {
      const loud = street === "river" && field < 0.05 && all < needed / 2;
      flags.push({
        code: "multiway-bluff",
        severity: loud ? "inaccurate" : "note",
        params: { opponents, all: pct(all), needed: pct(needed), equity: pct(field) },
      });
    }
  }

  if ((street === "flop" || street === "turn") && facts.made && (action === "check" || action === "call")) {
    const made = facts.made;
    const strongEnough =
      action === "call"
        ? STRONG_FOR_RAISE.has(made.class)
        : STRONG_MADE.has(made.class) &&
          (!ONE_PAIR_TOP.has(made.class) || made.class === "overpair" || made.kicker === "top" || made.kicker === "good");
    // Vulnerable: a board where a good share of the next cards change things.
    const vulnerable = (facts.texture?.volatility ?? 0) >= VULNERABLE_VOLATILITY;
    const ahead = action === "check" ? field >= SLOWPLAY_EQUITY : field >= SLOWPLAY_CALL_EQUITY;
    if (strongEnough && vulnerable && ahead && !(action === "check" && (facts.toCallBb > 0 || mw.raiserBehind))) {
      flags.push({ code: "multiway-slowplay", severity: "note", params: { opponents, equity: pct(field) } });
    }
  }

  if ((street === "flop" || street === "turn") && action === "call" && facts.potOdds !== null) {
    const nonNutFlush = facts.draws.includes("flush-draw") && !facts.draws.includes("nut-flush-draw");
    const nonNutStraight =
      (facts.draws.includes("oesd") || facts.draws.includes("gutshot")) && mw.outs !== null && mw.outs.nonNut > mw.outs.nut;
    const weakMade = !facts.made || !AT_LEAST_TOP_PAIR.has(facts.made.class);
    const callingOff = facts.allIn || (facts.heroStackBb > 0 && facts.toCallBb >= CALL_OFF_SHARE * facts.heroStackBb);
    if ((nonNutFlush || nonNutStraight) && weakMade && callingOff && field < facts.potOdds) {
      flags.push({
        code: "multiway-dominated-draw",
        severity: "note",
        params: { opponents, needed: pct(facts.potOdds), equity: pct(field) },
      });
    }
  }
  return flags;
}

/* ------------------------------------------------- the approximate call - */

export type RiverCallFailure = {
  ok: false;
  reason: "multiway-side-pot" | "multiway-crowded" | "multiway-range-unknown" | "multiway-reraise";
  detail: string;
};

export interface RiverCallInput {
  spot: Spot;
  facts: SpotFacts;
  hand: PhfHand;
  context: StatsContext;
  hero: number;
  walk: MultiWalk;
  model: NarrowingModel;
  charts: ChartSet | null;
  seed: number;
}

export interface RiverCallEv {
  ok: true;
  call: number;
  equity: number;
  pot: number;
  respond: MultiwayEv["respond"];
  scenarios: number;
  rake: string;
  /** Flop and turn only: the realisation factor applied to the share (`FLOP_REALISATION`, `TURN_REALISATION`). */
  realisation?: MultiwayEv["realisation"];
}

/* --------------------------------------------- the flop's realisation - */

/** The realisation table's id, stored with every approximate flop grade. */
export const FLOP_REALISATION_MODEL = "floplib-r/2";

/**
 * Flop realisation factors (`analysis/15`; refitted for `analysis/17` as
 * `floplib-r/2`): the share of the pot a hand facing a flop bet goes on to
 * win, as a multiple of its equity, measured on the flop library (heads-up,
 * `flop-m1`, the 6-max and 9-max 100bb lines as on 2026-10-10: 1,691 chunks):
 * per position after the call (last to act or not), the made-hand part of
 * `flopBucket` and whether the hand has a draw (a flush draw, open-ender or
 * gutshot; a backdoor is no draw). Fitted per category by least squares on
 *
 *     EV(call) − EV(fold) + toCall  ≈  R · equity · raked pot after the call
 *
 * (every number a fraction of the pot, each node's range weighted by reach)
 * at every node facing a bet or a raise **short of an all-in call**, which
 * realises its equity exactly (R = 1.0002 measured) and takes no factor -
 * the turn's rule (`floplib-r/1` was fitted with the all-in calls in).
 * Implied odds are in `R`: a set wins more than its equity of today's pot,
 * ace-high less. `tests/scripts/flop-library/realisation.ts` measures it
 * (`npm run floplib:realisation`); §10 of `docs/ANALYSIS-PLAN.md` has
 * the fit and its held-out error.
 */
export const FLOP_REALISATION: Readonly<Record<string, number>> = {
  "ip|ace-high|d": 1.016,
  "ip|ace-high|nd": 0.615,
  "ip|fh+|nd": 1.574,
  "ip|flush|nd": 1.421,
  "ip|middle|d": 0.93,
  "ip|middle|nd": 0.672,
  "ip|nothing|d": 1.158,
  "ip|nothing|nd": 0.685,
  "ip|overpair|d": 0.929,
  "ip|overpair|nd": 1.011,
  "ip|set|nd": 1.637,
  "ip|straight|d": 1.666,
  "ip|straight|nd": 1.54,
  "ip|tp-good|d": 0.974,
  "ip|tp-good|nd": 0.826,
  "ip|tp-top|d": 1.065,
  "ip|tp-top|nd": 0.954,
  "ip|tp-weak|d": 1.062,
  "ip|tp-weak|nd": 0.779,
  "ip|trips|nd": 1.306,
  "ip|two-pair|nd": 1.273,
  "ip|weak|d": 1.009,
  "ip|weak|nd": 0.728,
  "oop|ace-high|d": 0.836,
  "oop|ace-high|nd": 0.514,
  "oop|fh+|nd": 1.497,
  "oop|flush|nd": 1.288,
  "oop|middle|d": 0.807,
  "oop|middle|nd": 0.603,
  "oop|nothing|d": 0.988,
  "oop|nothing|nd": 0.522,
  "oop|overpair|d": 0.956,
  "oop|overpair|nd": 1.087,
  "oop|set|nd": 1.465,
  "oop|straight|d": 1.599,
  "oop|straight|nd": 1.425,
  "oop|tp-good|d": 0.909,
  "oop|tp-good|nd": 0.741,
  "oop|tp-top|d": 1.034,
  "oop|tp-top|nd": 0.912,
  "oop|tp-weak|d": 0.989,
  "oop|tp-weak|nd": 0.727,
  "oop|trips|nd": 1.217,
  "oop|two-pair|nd": 1.178,
  "oop|weak|d": 0.856,
  "oop|weak|nd": 0.595,
};

/** A category the table lacks (a set with a draw) reads its no-draw row, then the position's mean. */
export const FLOP_REALISATION_POSITION: Readonly<Record<"ip" | "oop", number>> = { ip: 0.993, oop: 0.868 };

/**
 * The flop grade counts only the EV loss beyond this share of the pot: the
 * realisation model's error. Held out on the library, a margin of 5% keeps
 * 80% of the Mistake-or-worse calls right (73% with none) at a cost of a few
 * mild misses (§10, `analysis/15`).
 */
export const FLOP_MARGIN_POT = 0.05;

/** The realisation category of a hole-card pair on a flop: `made|d` or `made|nd`, position apart. */
export function flopRealisationCategory(hole: readonly [number, number], board: readonly number[]): string {
  const [made, draw] = flopBucket(hole, board).split("/");
  return `${made}|${draw === "none" || draw === "bd" ? "nd" : "d"}`;
}

/** The realisation factor of a category (`flopRealisationCategory`) in or out of position. */
export function flopRealisation(category: string, ip: boolean): number {
  const pos = ip ? "ip" : "oop";
  const made = category.split("|")[0];
  return FLOP_REALISATION[`${pos}|${category}`] ?? FLOP_REALISATION[`${pos}|${made}|nd`] ?? FLOP_REALISATION_POSITION[pos];
}

/* --------------------------------------------- the turn's realisation - */

/** The turn realisation table's id, stored with every approximate turn grade. */
export const TURN_REALISATION_MODEL = "turnsolve-r/1";

/**
 * Turn realisation factors (`analysis/16`): the flop's (`FLOP_REALISATION`)
 * one street later - the share of the pot a hand facing a turn bet goes on to
 * win, as a multiple of its equity - measured on Rail's own heads-up turn
 * solves: A5a's turn solver (`TURN_PROFILE`, plus a third of a pot to the bet
 * menu) on a turn dealt to every flop ending of the 6-max 100bb flop library
 * that both ranges reach, each range as the library's strategy plays it
 * there (1,200 chunks, 6,505 turns, 3.35 million samples). Same categories (`flopRealisationCategory` on the turn board), same
 * fit on
 *
 *     EV(call) − EV(fold) + toCall  ≈  R · equity · raked pot after the call
 *
 * at every turn node facing a bet or a raise, short of an all-in call (which
 * realises its equity exactly). `tests/scripts/flop-library/turnRealisation.ts`
 * measures it (`npm run floplib:turn-realisation`); §10 of
 * `docs/ANALYSIS-PLAN.md` has the fit and its held-out error.
 */
export const TURN_REALISATION: Readonly<Record<string, number>> = {
  "ip|ace-high|d": 0.908,
  "ip|ace-high|nd": 0.672,
  "ip|fh+|nd": 1.299,
  "ip|flush|nd": 1.199,
  "ip|middle|d": 0.82,
  "ip|middle|nd": 0.71,
  "ip|nothing|d": 1.191,
  "ip|nothing|nd": 0.838,
  "ip|overpair|d": 0.842,
  "ip|overpair|nd": 0.883,
  "ip|set|nd": 1.273,
  "ip|straight|nd": 1.212,
  "ip|tp-good|d": 0.832,
  "ip|tp-good|nd": 0.803,
  "ip|tp-top|d": 0.877,
  "ip|tp-top|nd": 0.858,
  "ip|tp-weak|d": 0.871,
  "ip|tp-weak|nd": 0.763,
  "ip|trips|nd": 1.031,
  "ip|two-pair|nd": 1.006,
  "ip|weak|d": 0.886,
  "ip|weak|nd": 0.726,
  "oop|ace-high|d": 0.779,
  "oop|ace-high|nd": 0.578,
  "oop|fh+|nd": 1.223,
  "oop|flush|nd": 1.097,
  "oop|middle|d": 0.76,
  "oop|middle|nd": 0.655,
  "oop|nothing|d": 0.959,
  "oop|nothing|nd": 0.456,
  "oop|overpair|nd": 0.877,
  "oop|set|nd": 1.097,
  "oop|straight|nd": 1.112,
  "oop|tp-good|d": 0.769,
  "oop|tp-good|nd": 0.713,
  "oop|tp-top|nd": 0.795,
  "oop|tp-weak|d": 0.812,
  "oop|tp-weak|nd": 0.701,
  "oop|trips|nd": 0.968,
  "oop|two-pair|nd": 0.938,
  "oop|weak|d": 0.802,
  "oop|weak|nd": 0.629,
};

/**
 * A category the turn table lacks (under 50 nodes of weight: a set, trips,
 * two pair or straight with a draw, an overpair or top pair top kicker with
 * a draw out of position) reads its no-draw row, then the position's mean.
 */
export const TURN_REALISATION_POSITION: Readonly<Record<"ip" | "oop", number>> = { ip: 0.997, oop: 0.883 };

/** The turn grade counts only the EV loss beyond this share of the pot (the turn factor's own error, §10). */
export const TURN_MARGIN_POT = 0.05;

/** The turn realisation factor of a category (`flopRealisationCategory` on the turn board) in or out of position. */
export function turnRealisation(category: string, ip: boolean): number {
  const pos = ip ? "ip" : "oop";
  const made = category.split("|")[0];
  return TURN_REALISATION[`${pos}|${category}`] ?? TURN_REALISATION[`${pos}|${made}|nd`] ?? TURN_REALISATION_POSITION[pos];
}

/**
 * The EV of calling a river bet against folding, against the narrowed ranges
 * (module comment). Every amount in big blinds; a fold is 0.
 */
export function riverCallEv(input: RiverCallInput): RiverCallEv | RiverCallFailure {
  return callEv(input, "river");
}

/**
 * The EV of calling a turn bet against folding (`analysis/16`): the flop's,
 * with the turn's factor (`TURN_REALISATION`). A way in which the call leaves
 * the hero or every other player in it all-in takes no factor (no more
 * betting: the share is what the call wins).
 */
export function turnCallEv(input: RiverCallInput): RiverCallEv | RiverCallFailure {
  return callEv(input, "turn");
}

/**
 * The EV of calling a flop bet against folding (`analysis/15`): the river's
 * enumeration of who answers, with the hero's showdown share of each way
 * multiplied by its flop realisation factor (`FLOP_REALISATION`), in
 * position when the hero acts after every player left in that way. Since
 * `analysis/17` as the turn's: a way the call leaves all-in takes no factor,
 * and a re-raise is refused.
 */
export function flopCallEv(input: RiverCallInput): RiverCallEv | RiverCallFailure {
  return callEv(input, "flop");
}

function callEv(input: RiverCallInput, street: "flop" | "turn" | "river"): RiverCallEv | RiverCallFailure {
  const { spot, facts, hand, context, hero, walk } = input;
  const bb = Math.max(1, hand.game.bigBlind);
  const table = tableAt(hand, spot.action.index);
  const ranges = walk.before(spot.action.index);
  if (!table || !ranges) return { ok: false, reason: "multiway-range-unknown", detail: "no ranges at the decision" };
  const owed = table.high - spot.heroStreet;
  if (spot.toCall <= 0) return { ok: false, reason: "multiway-range-unknown", detail: "nothing to call" };
  if (spot.toCall < owed - 1e-9) return { ok: false, reason: "multiway-side-pot", detail: "the hero calls all-in for less" };
  if (table.opponents.some((o) => o.allIn && o.streetTotal < table.high)) {
    return { ok: false, reason: "multiway-side-pot", detail: "an opponent is all-in for less" };
  }
  const heroCards = toIndices(facts.holeCards);
  const heroRange = ranges.get(hero);
  if (!heroRange) return { ok: false, reason: "multiway-range-unknown", detail: "no hero range" };

  const fixed: Float64Array[] = [];
  const fixedSeats: number[] = [];
  // Chips behind once the bet is matched (the no-more-betting rule).
  const behindAfter = new Map<number, number>();
  const responders: Array<{ seat: number; amount: number; range: Float64Array }> = [];
  for (const opponent of table.opponents) {
    const range = ranges.get(opponent.seat);
    if (!range) return { ok: false, reason: "multiway-range-unknown", detail: `no range for seat ${opponent.seat}` };
    const own = prepared(range, heroCards, EV_PRUNE_SHARE);
    if (rangeWeight(own) <= 0) return { ok: false, reason: "multiway-range-unknown", detail: `seat ${opponent.seat}'s range is empty` };
    if (opponent.allIn || opponent.streetTotal >= table.high) {
      fixed.push(own);
      fixedSeats.push(opponent.seat);
      behindAfter.set(opponent.seat, opponent.allIn ? 0 : opponent.behind);
    } else {
      const amount = Math.min(table.high - opponent.streetTotal, opponent.behind);
      responders.push({ seat: opponent.seat, amount, range: own });
      behindAfter.set(opponent.seat, opponent.behind - amount);
    }
  }
  const heroAllIn = spot.heroBehind - spot.toCall <= 1e-9;
  // The flop's and the turn's factors were measured on trees with one raise
  // (`FLOP_PROFILE.flopRaiseCap`, `TURN_RAISE_CAP`): a re-raise is outside
  // them - unless the call ends the betting whoever answers (the hero, or every
  // other player, all-in), when no factor is applied and the share is exact.
  if (street !== "river") {
    const cap = street === "flop" ? FLOP_PROFILE.flopRaiseCap : TURN_RAISE_CAP;
    const aggressions = hand.actions.filter(
      (a) => a.street === street && a.index < spot.action.index && (a.type === "bet" || a.type === "raise"),
    ).length;
    const closes = heroAllIn || [...behindAfter.values()].every((behind) => behind <= 1e-9);
    if (aggressions > 1 + cap && !closes) {
      return { ok: false, reason: "multiway-reraise", detail: `${aggressions} bets and raises before the call` };
    }
  }
  if (responders.length > MAX_RESPONDERS) return { ok: false, reason: "multiway-crowded", detail: `${responders.length} to answer` };

  // Each player still to answer calls by the model's call likelihood against
  // the bet they face, with the hero's call in: multiway, the MDF split.
  const board = toIndices(facts.board);
  const strength = streetStrength(board);
  const players = table.opponents.length + 1;
  const sizePot = facts.facingPot ?? 0.5;
  const answers = responders.map((responder) => {
    const others = [heroRange, ...fixed, ...responders.filter((r) => r !== responder).map((r) => r.range)];
    const narrowInput: Omit<NarrowInput, "action"> = {
      street,
      board,
      actor: responder.range,
      opponent: others[0],
      strength,
    };
    if (others.length >= 2) {
      narrowInput.players = players;
      narrowInput.opponents = others;
    }
    const { share, range } = callShare(input.model, narrowInput, sizePot);
    return { ...responder, p: share, calling: range };
  });

  const rake = rakeOf(input.charts);
  const potBb = spot.potBefore / bb;
  const callBb = spot.toCall / bb;
  let ev = 0;
  let equity = 0;
  let expectedPot = 0;
  let scenarios = 0;
  // The flop and turn: the share realised later, by the hero's hand category
  // and whether the hero acts after everyone left in each way.
  const realised = street === "flop" || street === "turn";
  const category = realised && heroCards.length === 2 ? flopRealisationCategory([heroCards[0], heroCards[1]], board) : null;
  const factorOf = street === "turn" ? turnRealisation : flopRealisation;
  const orderOf = (seat: number) => table.order.get(seat) ?? Number.MAX_SAFE_INTEGER;
  let factorSum = 0;
  let ipShare = 0;
  let closedShare = 0;
  const ways = 1 << answers.length;
  for (let mask = 0; mask < ways; mask += 1) {
    let probability = 1;
    let pot = potBb + callBb;
    const field = [...fixed];
    const seats = [...fixedSeats];
    answers.forEach((answer, i) => {
      if (mask & (1 << i)) {
        probability *= answer.p;
        pot += answer.amount / bb;
        field.push(answer.calling);
        seats.push(answer.seat);
      } else {
        probability *= 1 - answer.p;
      }
    });
    if (!(probability > 0)) continue;
    scenarios += 1;
    const lists = field.map((range) => weightedCombos(range)).filter((list) => list.length > 0);
    const share =
      lists.length === 0
        ? 1
        : equityVsRanges({ hero: facts.holeCards, ranges: lists, board: facts.board, seed: input.seed + mask, trials: FIELD_TRIALS * 2 }).equity;
    // The solver's rake rule (`lib/solver/tree.ts`): a share of the final pot, capped.
    const raked = pot - Math.min(pot * rake.percent, rake.cap);
    let factor = 1;
    if (category !== null) {
      const ip = seats.every((seat) => orderOf(seat) < table.actorOrder);
      // Nobody left to bet against (the hero or every other player in this way all-in): the share is realised as it is.
      const closed = heroAllIn || seats.every((seat) => (behindAfter.get(seat) ?? 0) <= 1e-9);
      factor = closed ? 1 : factorOf(category, ip);
      factorSum += probability * factor;
      if (ip) ipShare += probability;
      if (closed) closedShare += probability;
    }
    ev += probability * (factor * share * raked - callBb);
    equity += probability * share;
    expectedPot += probability * pot;
  }
  return {
    ok: true,
    call: round3(ev),
    equity: round3(equity),
    pot: round2(expectedPot),
    respond: answers.map((answer) => ({
      position: (context.position.get(answer.seat) ?? null) as Position | null,
      call: round3(answer.p),
    })),
    scenarios,
    rake: rake.name,
    ...(category !== null
      ? {
          realisation: {
            model: street === "turn" ? TURN_REALISATION_MODEL : FLOP_REALISATION_MODEL,
            category,
            factor: round3(factorSum),
            ip: round3(ipShare),
            margin: street === "turn" ? TURN_MARGIN_POT : FLOP_MARGIN_POT,
            ...(closedShare > 0 ? { allIn: round3(closedShare) } : {}),
          },
        }
      : {}),
  };
}

export interface ApproxGrade extends GradeResult {
  ok: true;
  options: Array<{ action: "fold" | "call"; freq: number; ev: number }>;
  chosen: number;
  ev: MultiwayEv;
  approximations: Approximation[];
}

/**
 * The approximate grade of a river call or fold (A9): fold (EV 0) against
 * call (`riverCallEv`), the better one at frequency 1 — a best response, not
 * a mix — graded by §2 and capped at Mistake unless the move loses whatever
 * the opponents hold (`dominated`).
 */
export function gradeRiverCall(evs: RiverCallEv, action: "fold" | "call", potBb: number, dominated: boolean): ApproxGrade {
  return gradeCall(evs, action, potBb, dominated, 0);
}

/**
 * The approximate grade of a flop call or fold (`analysis/15`): as the
 * river's, on `flopCallEv`, but only the EV loss beyond `FLOP_MARGIN_POT` of
 * the pot counts - the realisation model's own error - and it is always
 * capped at Mistake (on the flop no hand loses to everything for sure). The
 * options carry the EV beyond the margin (the grade is §2 of the options,
 * as everywhere); the model's own EV of the call stays in `ev.call`.
 */
export function gradeFlopCall(evs: RiverCallEv, action: "fold" | "call", potBb: number): ApproxGrade {
  return gradeCall(evs, action, potBb, false, FLOP_MARGIN_POT, "flop-realisation");
}

/**
 * The approximate grade of a turn call or fold (`analysis/16`): the flop's,
 * on `turnCallEv`, beyond `TURN_MARGIN_POT` of the pot, always capped at
 * Mistake, labelled `turn-realisation`.
 */
export function gradeTurnCall(evs: RiverCallEv, action: "fold" | "call", potBb: number): ApproxGrade {
  return gradeCall(evs, action, potBb, false, TURN_MARGIN_POT, "turn-realisation");
}

function gradeCall(
  evs: RiverCallEv,
  action: "fold" | "call",
  potBb: number,
  dominated: boolean,
  margin: number,
  realisation: "flop-realisation" | "turn-realisation" | null = null,
): ApproxGrade {
  const callBest = evs.call > 0;
  const options: ApproxGrade["options"] = [
    { action: "fold", freq: callBest ? 0 : 1, ev: 0 },
    { action: "call", freq: callBest ? 1 : 0, ev: evs.call },
  ];
  const chosen = action === "fold" ? 0 : 1;
  // Within the margin the two are too close for the model to call: no loss.
  const beyond = Math.sign(evs.call) * Math.max(0, Math.abs(evs.call) - margin * potBb);
  const graded = margin > 0 ? options.map((option) => ({ ...option, ev: option.action === "call" ? beyond : 0 })) : options;
  const raw = grade({ options: graded, chosen, pot: potBb });
  const capped = !dominated && gradeRank(raw.grade) > gradeRank("mistake");
  const result = capped ? grade({ options: graded, chosen, pot: potBb, capAtMistake: true }) : raw;
  const approximations: Approximation[] = ["multiway-approx", "narrowing-heuristic", "rake-profile"];
  if (realisation) approximations.push(realisation);
  if (capped) approximations.push("range-cap");
  return {
    ...result,
    ok: true,
    options: graded,
    chosen,
    approximations: approximations.sort(),
    ev: {
      call: evs.call,
      equity: evs.equity,
      pot: evs.pot,
      respond: evs.respond,
      scenarios: evs.scenarios,
      rake: evs.rake,
      capped: capped ? (raw.grade as Grade) : null,
      sensitivity: null,
      ...(evs.realisation ? { realisation: evs.realisation } : {}),
    },
  };
}
