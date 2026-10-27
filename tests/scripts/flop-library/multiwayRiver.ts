/**
 * Study code (§10, 2026-10-19, "Multiway checks and bets: not shipped"): a
 * model of a multiway river check or bet, built to test whether one can be
 * graded. Nothing in the app reads it.
 *
 * On the river nothing is left to come, so a check or a bet against fixed
 * ranges is a small tree: who answers the bet, who bets after a check, and
 * the showdown share of whoever is left. What no solver gives multiway is how
 * the field plays that tree; two answers are tried:
 *
 * - **the population** (`POPULATION_ANSWERS`, `POPULATION_OPENS`): logistic
 *   models fitted on the stored hands of every player - how often a player
 *   facing a bet calls (or raises) by street, size, players to answer and what
 *   those before did; how often a player not facing a bet bets; the calling
 *   and betting ranges are the top of each range by strength against the
 *   field (`callAtShare`) and the heuristic's betting shape (`atShare`), at
 *   those shares;
 * - **the theory**: the narrowing model's own answers (`heuristic/2`, the
 *   MDF split for calls, its betting share for bets), what the multiway call
 *   grades assume.
 *
 * Raises are not in the tree (a raise answers like a call). The EV of every
 * option is net from the decision in bb; the would-be grade takes the smaller
 * EV loss of the two fields (`gradeRiverCheckBet`), beyond
 * `RIVER_BET_MARGIN_POT` of the pot, capped at Mistake.
 */

import type { ChartSet } from "../../../web/src/lib/charts/index.js";
import { equityVsRanges } from "../../../web/src/lib/equity/multiway.js";
import type { PhfHand, Position } from "../../../web/src/lib/phf/types.js";
import type { StatsContext } from "../../../web/src/lib/stats/context.js";
import {
  effectiveStrength,
  grade,
  gradeRank,
  handStrength,
  heuristicModel,
  narrow,
  percentiles,
  rakeOf,
  rangeWeight,
  removeCards,
  streetStrength,
  tableAt,
  weightedCombos,
  type Grade,
  type GradeResult,
  type MultiWalk,
  type NarrowingModel,
  type NarrowInput,
  type OptionAnalysis,
  type Spot,
  type StreetStrength,
} from "../../../web/src/lib/analysis/index.js";
import { RAMP } from "../../../web/src/lib/analysis/narrowing.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";

/* ------------------------------------------------- shares of a range - */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function ramp(q: number, from: number, to: number): number {
  if (q <= from) return 0;
  if (q >= to) return 1;
  return (q - from) / (to - from);
}

/**
 * A likelihood rescaled so the share of `actor` (by weight) that takes the
 * action is exactly `share`: `min(1, k · L)` with `k` found by bisection. The
 * order of the combos is `L`'s; only how many take the action is set.
 */
export function atShare(
  likelihood: Float64Array,
  actor: Float64Array,
  share: number,
): Float64Array {
  const target = clamp01(share);
  let total = 0;
  for (let c = 0; c < actor.length; c += 1) if (actor[c] > 0) total += actor[c];
  const out = new Float64Array(actor.length);
  if (!(total > 0)) return out;
  const mass = (k: number) => {
    let s = 0;
    for (let c = 0; c < actor.length; c += 1)
      if (actor[c] > 0)
        s += actor[c] * Math.min(1, k * Math.max(0, likelihood[c] || 0));
    return s / total;
  };
  let lo = 0;
  let hi = 1;
  while (mass(hi) < target && hi < 1e9) hi *= 2;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (mass(mid) < target) lo = mid;
    else hi = mid;
  }
  for (let c = 0; c < actor.length; c += 1)
    out[c] = Math.min(1, hi * Math.max(0, likelihood[c] || 0));
  return out;
}

/**
 * The calling likelihood of `input.actor` facing a bet when a known share of
 * it calls: the heuristic's call shape (its strength percentile against the
 * field, `heuristic/2`) with the cut at `1 − share` - the top of the range
 * calls - rescaled to `share` exactly.
 */
export function callAtShare(
  input: Omit<NarrowInput, "action">,
  share: number,
): Float64Array {
  const strength = input.strength ?? streetStrength(input.board);
  let hs = handStrength(strength, input.opponent);
  if (input.opponents && input.opponents.length >= 2) {
    hs = handStrength(strength, input.opponents[0]);
    for (let i = 1; i < input.opponents.length; i += 1) {
      const other = handStrength(strength, input.opponents[i]);
      for (let c = 0; c < hs.length; c += 1) hs[c] *= other[c];
    }
  }
  const q = percentiles(effectiveStrength(strength, hs), input.actor);
  const cut = 1 - clamp01(share);
  const out = new Float64Array(input.actor.length);
  for (let c = 0; c < out.length; c += 1) {
    if (!(input.actor[c] > 0) || Number.isNaN(q[c])) continue;
    out[c] = Math.max(1e-6, ramp(q[c], cut - RAMP / 2, cut + RAMP / 2));
  }
  return atShare(out, input.actor, share);
}

/** How the grade read the EVs (study only: nothing is stored). */
export interface MultiwayCheckBet {
  models: Array<{
    id: string;
    check: number;
    bets: Array<{ size: number; ev: number; allFold: number }>;
    betBehind: number;
  }>;
  margin: number;
  capped: Grade | null;
  sensitivity: { model: string; grade: Grade } | null;
}

/* ---------------------------------------------------------- the models - */

export type PostflopStreet = "flop" | "turn" | "river";

/** A player facing a bet, as the population model reads them. */
export interface AnswerContext {
  street: PostflopStreet;
  /** The bet over the pot before it. */
  size: number;
  /** Players to answer the bet when it was made. */
  facing: number;
  /** This player's place among them (0 first). */
  order: number;
  /** Someone before this player has called the bet. */
  priorCall: boolean;
  /** This player checked earlier on the street (checked to the bettor). */
  checkedBefore: boolean;
}

/** A player not facing a bet, as the population model reads them. */
export interface OpenContext {
  street: PostflopStreet;
  /** Players in the pot. */
  players: number;
  /** Players who checked before this one on the street. */
  checksBefore: number;
  /** Players still to act after this one. */
  behind: number;
}

const STREETS: readonly PostflopStreet[] = ["flop", "turn", "river"];

/** The answer model's features (`POPULATION_ANSWERS.weights`, in this order). */
export function answerFeatures(a: AnswerContext): number[] {
  const s = STREETS.indexOf(a.street);
  const x = new Array(10).fill(0);
  x[s] = 1;
  x[3 + s] = Math.log(Math.max(0.05, a.size));
  x[6] = a.facing - 2;
  x[7] = a.priorCall ? 1 : 0;
  x[8] = a.order > 0 && !a.priorCall ? 1 : 0;
  x[9] = a.checkedBefore ? 1 : 0;
  return x;
}

/** The open model's features (`POPULATION_OPENS.weights`, in this order). */
export function openFeatures(o: OpenContext): number[] {
  const s = STREETS.indexOf(o.street);
  const x = new Array(8).fill(0);
  x[s] = 1;
  x[3] = o.players - 3;
  x[4] = o.checksBefore > 0 ? 1 : 0;
  x[5] = o.behind === 0 ? 1 : 0;
  x[6] = o.street === "river" && o.behind === 0 ? 1 : 0;
  x[7] = o.street === "river" && o.checksBefore > 0 ? 1 : 0;
  return x;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const logistic = (w: readonly number[], x: readonly number[]) =>
  sigmoid(x.reduce((s, v, i) => s + v * (w[i] ?? 0), 0));

export interface PopulationModel {
  id: string;
  weights: readonly number[];
}

/**
 * P(call or raise) facing a bet in a pot three or more saw the flop of,
 * fitted on every answer of the owner's stored hands (§10, 2026-10-19; the
 * study refits it per fold for anything held out).
 */
export const POPULATION_ANSWERS: PopulationModel = {
  id: "mw-answers/1",
  weights: [
    -0.591, -0.88, -1.261, -0.681, -0.91, -0.866, -0.328, -0.081, 0.085, -0.521,
  ],
};

/** P(bet) when not facing a bet in such a pot (§10, 2026-10-19). */
export const POPULATION_OPENS: PopulationModel = {
  id: "mw-opens/1",
  weights: [-1.761, -1.521, -1.174, -0.087, 0.454, 0.633, -0.196, -0.954],
};

/** The size a player bets when checked to on the river, a fraction of the pot (the stored hands' median, §10). */
export const POPULATION_RIVER_BET = 0.56;

/** The bet sizes a check is compared against, fractions of the pot. */
export const RIVER_BET_MENU: readonly number[] = [0.33, 0.66, 1];

/** The grade counts only the EV loss beyond this share of the pot (the models' disagreement it forgives). */
export const RIVER_BET_MARGIN_POT = 0.05;

/** At most this many opponents (2³ ways to answer a bet). */
export const RIVER_BET_MAX_OPPONENTS = 3;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Monte Carlo deals per showdown share that cannot be enumerated. */
const TRIALS = 8_000;

/** How the field answers and opens: the population's or the theory's. */
export interface FieldModel {
  id: string;
  /** P(call or raise) and the calling range of `input.actor`. */
  answer(
    ctx: AnswerContext,
    input: Omit<NarrowInput, "action">,
    size: number,
  ): { p: number; range: Float64Array };
  /** P(bet) and the betting range of `input.actor` when checked to, betting `size` of the pot. */
  open(
    ctx: OpenContext,
    input: Omit<NarrowInput, "action">,
    size: number,
  ): { p: number; range: Float64Array; checked: Float64Array };
}

function splitBy(
  actor: Float64Array,
  likelihood: Float64Array,
): { p: number; range: Float64Array; checked: Float64Array } {
  const range = new Float64Array(actor.length);
  const checked = new Float64Array(actor.length);
  for (let c = 0; c < actor.length; c += 1) {
    const w = actor[c];
    if (!(w > 0)) continue;
    const l = Math.min(1, Math.max(0, likelihood[c] || 0));
    range[c] = w * l;
    checked[c] = w * (1 - l);
  }
  const total = rangeWeight(actor);
  return { p: total > 0 ? rangeWeight(range) / total : 0, range, checked };
}

/** The population's field (`POPULATION_ANSWERS`, `POPULATION_OPENS`), with model weights to swap for held-out fits. */
export function populationField(
  answers: readonly number[] = POPULATION_ANSWERS.weights,
  opens: readonly number[] = POPULATION_OPENS.weights,
  shape: NarrowingModel = heuristicModel,
): FieldModel {
  return {
    id: `${POPULATION_ANSWERS.id}+${POPULATION_OPENS.id}`,
    answer(ctx, input) {
      const p = logistic(answers, answerFeatures(ctx));
      const l = callAtShare(input, p);
      return { p, range: splitBy(input.actor, l).range };
    },
    open(ctx, input, size) {
      const p = logistic(opens, openFeatures(ctx));
      const shapeL = shape.likelihood({
        ...input,
        action: { kind: "bet", sizePot: size, allIn: false },
      });
      return splitBy(input.actor, atShare(shapeL, input.actor, p));
    },
  };
}

/** The theory's field: the narrowing model's own call and bet likelihoods. */
export function theoryField(
  model: NarrowingModel = heuristicModel,
): FieldModel {
  return {
    id: model.id,
    answer(_ctx, input, size) {
      const range = narrow(
        { ...input, action: { kind: "call", sizePot: size, allIn: false } },
        model,
      );
      const total = rangeWeight(input.actor);
      return { p: total > 0 ? rangeWeight(range) / total : 0, range };
    },
    open(_ctx, input, size) {
      return splitBy(
        input.actor,
        model.likelihood({
          ...input,
          action: { kind: "bet", sizePot: size, allIn: false },
        }),
      );
    },
  };
}

/* ------------------------------------------------------------- the EV - */

export interface RiverOpponent {
  seat: number;
  position: Position | null;
  /** The range at the decision, the hero's cards removed. */
  range: Float64Array;
  /** Acts after the hero on this street (has not acted yet). */
  behind: boolean;
}

export interface RiverCheckBetInput {
  heroCodes: readonly string[];
  boardCodes: readonly string[];
  board: readonly number[];
  strength: StreetStrength;
  /** The hero's range at the decision. */
  heroRange: Float64Array;
  /** Live opponents in this street's acting order. */
  opponents: readonly RiverOpponent[];
  potBb: number;
  /** The most anyone can bet: the hero's stack against the deepest opponent, bb. */
  maxBetBb: number;
  /** Bet sizes to evaluate, fractions of the pot. */
  sizes: readonly number[];
  rake: { percent: number; cap: number };
  seed: number;
}

export interface RiverCheckBetEv {
  /** EV of checking, bb, net from the decision. */
  check: number;
  /** EV of each bet size, bb. */
  bets: Array<{ size: number; ev: number; allFold: number }>;
  /** Chance a player behind bets after the check (0 when the hero is last). */
  betBehind: number;
}

function shareOf(
  heroCodes: readonly string[],
  boardCodes: readonly string[],
  ranges: readonly Float64Array[],
  seed: number,
): number {
  const lists = ranges
    .map((range) => weightedCombos(range))
    .filter((list) => list.length > 0);
  if (lists.length === 0) return 1;
  return equityVsRanges({
    hero: [...heroCodes],
    ranges: lists,
    board: [...boardCodes],
    seed,
    trials: TRIALS,
  }).equity;
}

function inputFor(
  input: RiverCheckBetInput,
  actor: Float64Array,
  others: readonly Float64Array[],
): Omit<NarrowInput, "action"> {
  const narrowInput: Omit<NarrowInput, "action"> = {
    street: "river",
    board: input.board,
    actor,
    opponent: others[0],
    strength: input.strength,
  };
  if (others.length >= 2) {
    narrowInput.players = others.length + 1;
    narrowInput.opponents = others;
  }
  return narrowInput;
}

/**
 * EV of a bet of `size` (a fraction of the pot): every opponent answers in
 * turn - those behind the hero first, then those who checked - calling or
 * folding by `field`; the callers' ranges are their calling ranges; nobody
 * raises. Everyone folding wins the pot.
 */
export function riverBetEv(
  input: RiverCheckBetInput,
  field: FieldModel,
  size: number,
): { ev: number; allFold: number } {
  const bet = Math.min(size * input.potBb, input.maxBetBb);
  const sizePot = bet / input.potBb;
  const order = [
    ...input.opponents.filter((o) => o.behind),
    ...input.opponents.filter((o) => !o.behind),
  ];
  const heroBet = narrow({
    ...inputFor(
      input,
      input.heroRange,
      order.map((o) => o.range),
    ),
    action: { kind: "bet", sizePot, allIn: false },
  });
  const raked = (pot: number) =>
    pot - Math.min(pot * input.rake.percent, input.rake.cap);
  const answers = new Map<string, { p: number; range: Float64Array }>();
  const answerOf = (i: number, priorCall: boolean) => {
    const key = `${i}|${priorCall}`;
    let found = answers.get(key);
    if (!found) {
      const o = order[i];
      const others = [
        heroBet,
        ...order.filter((x) => x !== o).map((x) => x.range),
      ];
      found = field.answer(
        {
          street: "river",
          size: sizePot,
          facing: order.length,
          order: i,
          priorCall,
          checkedBefore: !o.behind,
        },
        inputFor(input, o.range, others),
        sizePot,
      );
      answers.set(key, found);
    }
    return found;
  };
  let ev = 0;
  let allFold = 0;
  const walk = (
    i: number,
    probability: number,
    callers: Float64Array[],
    mask: number,
  ) => {
    if (!(probability > 0)) return;
    if (i === order.length) {
      if (callers.length === 0) {
        allFold += probability;
        ev += probability * raked(input.potBb);
        return;
      }
      const pot = input.potBb + bet * (1 + callers.length);
      const share = shareOf(
        input.heroCodes,
        input.boardCodes,
        callers,
        input.seed + mask,
      );
      ev += probability * (share * raked(pot) - bet);
      return;
    }
    const a = answerOf(i, callers.length > 0);
    walk(i + 1, probability * a.p, [...callers, a.range], mask | (1 << i));
    walk(i + 1, probability * (1 - a.p), callers, mask);
  };
  walk(0, 1, [], 0);
  return { ev, allFold };
}

/**
 * EV of checking: with nobody behind, the showdown share of the pot. With
 * players behind, each in turn bets `POPULATION_RIVER_BET` of the pot or
 * checks by `field`; after a bet the hero calls or folds, whichever is
 * better, the others answering it by `field` (nobody raises); if all check,
 * the showdown against the checked ranges.
 */
export function riverCheckEv(
  input: RiverCheckBetInput,
  field: FieldModel,
): { ev: number; betBehind: number } {
  const raked = (pot: number) =>
    pot - Math.min(pot * input.rake.percent, input.rake.cap);
  const behind = input.opponents.filter((o) => o.behind);
  const heroChecked = narrow({
    ...inputFor(
      input,
      input.heroRange,
      input.opponents.map((o) => o.range),
    ),
    action: { kind: "check", sizePot: null, allIn: false },
  });
  if (behind.length === 0) {
    return {
      ev:
        shareOf(
          input.heroCodes,
          input.boardCodes,
          input.opponents.map((o) => o.range),
          input.seed,
        ) * raked(input.potBb),
      betBehind: 0,
    };
  }
  const ranges = new Map(input.opponents.map((o) => [o.seat, o.range]));
  let reach = 1;
  let ev = 0;
  let betBehind = 0;
  const checksBefore = input.opponents.length - behind.length + 1;
  behind.forEach((bettor, j) => {
    if (!(reach > 0)) return;
    const others = [
      heroChecked,
      ...input.opponents
        .filter((o) => o.seat !== bettor.seat)
        .map((o) => ranges.get(o.seat) as Float64Array),
    ];
    const size = Math.min(POPULATION_RIVER_BET * input.potBb, input.maxBetBb);
    const sizePot = size / input.potBb;
    const opened = field.open(
      {
        street: "river",
        players: input.opponents.length + 1,
        checksBefore: checksBefore + j,
        behind: behind.length - j - 1,
      },
      inputFor(input, ranges.get(bettor.seat) as Float64Array, others),
      sizePot,
    );
    const pBet = reach * opened.p;
    if (pBet > 0 && rangeWeight(opened.range) > 0) {
      // The hero facing the bet; the others answer it in turn (the hero left out of their order).
      const rest = input.opponents.filter((o) => o.seat !== bettor.seat);
      let call = 0;
      const walk = (
        i: number,
        probability: number,
        callers: Float64Array[],
        mask: number,
      ) => {
        if (!(probability > 0)) return;
        if (i === rest.length) {
          const pot = input.potBb + size * (2 + callers.length);
          const share = shareOf(
            input.heroCodes,
            input.boardCodes,
            [opened.range, ...callers],
            input.seed + 97 * (j + 1) + mask,
          );
          call += probability * (share * raked(pot) - size);
          return;
        }
        const o = rest[i];
        const answerOthers = [
          opened.range,
          heroChecked,
          ...rest
            .filter((x) => x !== o)
            .map((x) => ranges.get(x.seat) as Float64Array),
        ];
        const a = field.answer(
          {
            street: "river",
            size: sizePot,
            facing: rest.length + 1,
            order: i + 1,
            priorCall: callers.length > 0,
            checkedBefore: !o.behind,
          },
          inputFor(input, ranges.get(o.seat) as Float64Array, answerOthers),
          sizePot,
        );
        walk(i + 1, probability * a.p, [...callers, a.range], mask | (1 << i));
        walk(i + 1, probability * (1 - a.p), callers, mask);
      };
      walk(0, 1, [], 0);
      ev += pBet * Math.max(0, call);
      betBehind += pBet;
    }
    reach *= 1 - opened.p;
    ranges.set(bettor.seat, opened.checked);
  });
  if (reach > 0) {
    const share = shareOf(
      input.heroCodes,
      input.boardCodes,
      input.opponents.map((o) => ranges.get(o.seat) as Float64Array),
      input.seed + 7,
    );
    ev += reach * share * raked(input.potBb);
  }
  return { ev, betBehind };
}

/** The check and every bet size under one field model. */
export function riverCheckBetEv(
  input: RiverCheckBetInput,
  field: FieldModel,
): RiverCheckBetEv {
  const check = riverCheckEv(input, field);
  const bets = input.sizes.map((size) => ({
    size,
    ...riverBetEv(input, field, size),
  }));
  return { check: check.ev, bets, betBehind: check.betBehind };
}

/* ---------------------------------------------------------- the spot - */

export type RiverBetFailure = {
  ok: false;
  reason: "multiway-side-pot" | "multiway-crowded" | "multiway-range-unknown";
  detail: string;
};

/** Combos under this share of a range's heaviest are dropped (as the river call's EV does). */
const PRUNE_SHARE = 0.002;

function prepared(
  range: Float64Array,
  heroCards: readonly number[],
): Float64Array {
  const out = removeCards(Float64Array.from(range), heroCards);
  let max = 0;
  for (let c = 0; c < out.length; c += 1) max = Math.max(max, out[c]);
  for (let c = 0; c < out.length; c += 1)
    if (out[c] < max * PRUNE_SHARE) out[c] = 0;
  return out;
}

/**
 * The input of `riverCheckBetEv` at a hero river decision not facing a bet
 * in a pot of three or more: the walked ranges at the decision, who acts
 * behind, the pot and the deepest bet. Refused with all-in players (side
 * pots), more than `RIVER_BET_MAX_OPPONENTS` opponents, or no ranges.
 */
export function riverCheckBetInput(
  spot: Spot,
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  walk: MultiWalk,
  charts: ChartSet | null,
  sizes: readonly number[],
  seed: number,
): RiverCheckBetInput | RiverBetFailure {
  const bb = Math.max(1, hand.game.bigBlind);
  const table = tableAt(hand, spot.action.index);
  const ranges = walk.before(spot.action.index);
  if (!table || !ranges)
    return {
      ok: false,
      reason: "multiway-range-unknown",
      detail: "no ranges at the decision",
    };
  if (spot.toCall > 0)
    return {
      ok: false,
      reason: "multiway-range-unknown",
      detail: "facing a bet",
    };
  if (
    spot.heroBehind <= 0 ||
    table.opponents.some((o) => o.allIn || o.behind <= 0)
  ) {
    return {
      ok: false,
      reason: "multiway-side-pot",
      detail: "a player is all-in",
    };
  }
  if (table.opponents.length > RIVER_BET_MAX_OPPONENTS) {
    return {
      ok: false,
      reason: "multiway-crowded",
      detail: `${table.opponents.length} opponents`,
    };
  }
  const heroCards = toIndices(context.players.get(hero)?.holeCards ?? []);
  const heroRange = ranges.get(hero);
  if (heroCards.length !== 2 || !heroRange)
    return {
      ok: false,
      reason: "multiway-range-unknown",
      detail: "no hero range",
    };
  const opponents: RiverOpponent[] = [];
  for (const o of table.opponents) {
    const range = ranges.get(o.seat);
    if (!range)
      return {
        ok: false,
        reason: "multiway-range-unknown",
        detail: `no range for seat ${o.seat}`,
      };
    const own = prepared(range, heroCards);
    if (rangeWeight(own) <= 0)
      return {
        ok: false,
        reason: "multiway-range-unknown",
        detail: `seat ${o.seat}'s range is empty`,
      };
    opponents.push({
      seat: o.seat,
      position: (context.position.get(o.seat) ?? null) as Position | null,
      range: own,
      behind:
        (table.order.get(o.seat) ?? Number.MAX_SAFE_INTEGER) > table.actorOrder,
    });
  }
  const board = toIndices(spot.board);
  if (board.length !== 5)
    return { ok: false, reason: "multiway-range-unknown", detail: "no river" };
  const deepest = Math.max(...table.opponents.map((o) => o.behind));
  const shallowest = Math.min(...table.opponents.map((o) => o.behind));
  const rake = rakeOf(charts);
  return {
    heroCodes: context.players.get(hero)?.holeCards ?? [],
    boardCodes: spot.board,
    board,
    strength: streetStrength(board),
    heroRange: removeCards(Float64Array.from(heroRange), []),
    opponents,
    potBb: spot.potBefore / bb,
    // Every caller must cover the bet (no side pots): the shallowest opponent's stack bounds it.
    maxBetBb: Math.min(spot.heroBehind, shallowest, deepest) / bb,
    sizes,
    rake: { percent: rake.percent, cap: rake.cap },
    seed,
  };
}

/* ----------------------------------------------------------- the grade - */

export interface RiverBetGrade extends GradeResult {
  ok: true;
  options: OptionAnalysis[];
  chosen: number;
  approximations: string[];
  /** The facts: each field model's EVs (bb), the margin, the cap. */
  checkBet: MultiwayCheckBet;
}

/**
 * The grade of a multiway river check or bet: under each field model the
 * chosen option's EV loss against the best option; the smaller loss of the
 * models (both must say it loses), beyond `RIVER_BET_MARGIN_POT` of the pot,
 * graded by §2 and capped at Mistake. The options carry the population's EVs
 * with the chosen option's loss set to the graded one.
 */
export function gradeRiverCheckBet(
  evs: ReadonlyArray<{ id: string } & RiverCheckBetEv>,
  action: "check" | "bet",
  betSize: number | null,
  potBb: number,
): RiverBetGrade {
  const lossOf = (e: RiverCheckBetEv) => {
    const values = [e.check, ...e.bets.map((b) => b.ev)];
    const best = Math.max(...values);
    const mine =
      action === "check"
        ? e.check
        : (e.bets.find((b) => b.size === betSize)?.ev ?? e.bets[0].ev);
    return Math.max(0, best - mine);
  };
  const losses = evs.map(lossOf);
  const loss = Math.min(...losses);
  const beyond = Math.max(0, loss - RIVER_BET_MARGIN_POT * potBb);
  const population = evs[0];
  // The options: check and the bets as the population values them; the
  // chosen option's EV is placed `beyond` under the best option.
  const options: OptionAnalysis[] = [
    { action: "check", freq: 0, ev: population.check },
    ...population.bets.map((b) => ({
      action: "bet" as const,
      sizePot: b.size,
      size: Math.round(b.size * potBb * 100) / 100,
      freq: 0,
      ev: b.ev,
    })),
  ];
  const chosen =
    action === "check"
      ? 0
      : Math.max(1, 1 + population.bets.findIndex((b) => b.size === betSize));
  const others = options.filter((_, i) => i !== chosen);
  const bestOther = Math.max(...others.map((o) => o.ev));
  options[chosen] = {
    ...options[chosen],
    ev:
      beyond > 0 ? bestOther - beyond : Math.max(options[chosen].ev, bestOther),
  };
  const top = Math.max(...options.map((o) => o.ev));
  for (const o of options) o.freq = o.ev >= top - 1e-12 ? 1 : 0;
  const raw = grade({ options, chosen, pot: potBb });
  const capped = gradeRank(raw.grade) > gradeRank("mistake");
  const result = capped
    ? grade({ options, chosen, pot: potBb, capAtMistake: true })
    : raw;
  const approximations: string[] = [
    "multiway-approx",
    "multiway-bet-approx (study)",
    "narrowing-heuristic",
    "rake-profile",
  ];
  if (capped) approximations.push("range-cap");
  return {
    ...result,
    ok: true,
    options,
    chosen,
    approximations: approximations.sort(),
    checkBet: {
      models: evs.map((e) => ({
        id: e.id,
        check: round3(e.check),
        bets: e.bets.map((b) => ({
          size: round3(b.size),
          ev: round3(b.ev),
          allFold: round3(b.allFold),
        })),
        betBehind: round3(e.betBehind),
      })),
      margin: RIVER_BET_MARGIN_POT,
      capped: capped ? (raw.grade as Grade) : null,
      sensitivity: null,
    },
  };
}
