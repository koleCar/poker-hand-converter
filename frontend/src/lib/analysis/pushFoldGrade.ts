/**
 * Tournament decisions graded by the push/fold game (R5.5).
 *
 * ```
 * PhfHand ─▶ pushFoldSpot (the line: first in, or facing a first-in push)
 *          ─▶ tournamentModel (payouts, players left, the field)
 *          ─▶ PushFoldGame (the table's stacks and posts; prize equity of every end)
 *          ─▶ solvePushFold (CFR+) ─▶ the hero's EV of each option ─▶ grade() (§2)
 * ```
 *
 * **What is graded**: a hero's preflop decision with at most
 * `PUSH_FOLD_MAX_BB` effective, when everyone in front folded - all in or
 * fold - or when one player in front went all in first in and everyone
 * between folded - call or fold. A limp, a raise short of all in, a re-raise
 * over a push, a line with a raise that is not a push, a straddle or a dead
 * blind is outside the game: `tournament-not-push-fold`. Deeper than 20bb:
 * `tournament-deep`. Everything after the flop: `tournament-postflop`.
 *
 * **What the grade means**: the hero's EV of each option against the
 * equilibrium of the push/fold game from the first pusher on, in prize
 * equity (`icm`) or in chips (a multi-table tournament nobody described, see
 * `tournament.ts`). The EVs are written in **big blinds at the tournament's
 * average price of a chip** (the prize pool still to be paid over the chips
 * in play: in chips exactly big blinds), net from the start of the hand as a
 * chart's EVs are, so §2's thresholds read them as they read a chart grade:
 * the share of the pot before the decision, no big-blind floor. The option's
 * frequency is the equilibrium's for the hero's class.
 *
 * The reference is never better than a real strategy could be: pushing or
 * folding is a subset of what the hero could do, so an EV loss here is a
 * floor of the loss against the true best play when the hero folded, and the
 * push itself is graded only against folding. Said on every grade
 * (`push-fold`).
 */

import { handClass } from "../cards";
import type { PhfAction, PhfHand, Position } from "../phf/types";
import { classByName, HAND_CLASSES } from "../solver";
import type { StatsContext } from "../stats/context";
import { grade, type GradeResult } from "./grading";
import { allInPrice, icm, type IcmResult } from "./icm";
import { callValues, pushFoldPlayable, pushValues, rangeShare, solvePushFold, type PushFoldGame, type PushFoldPlayer } from "./pushFold";
import { remainingPrizes, tableStacks, tournamentModel, type TournamentModel, type TournamentSettings } from "./tournament";
import type { Approximation, IcmFacts, OptionAnalysis, TournamentSkipReason } from "./types";
import type { Spot } from "./walk";

/** Deeper than this many big blinds effective, a decision is not push/fold. */
export const PUSH_FOLD_MAX_BB = 20;
/** The solver's cost grows with the cube of the table; ten seats is the most any room deals. */
const MAX_PLAYERS = 10;
/** A caller (not the last to act) with less than this share of the push behind makes a side pot: not graded. */
export const SIDE_POT_SHARE = 0.5;

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

const DECISION_TYPES = new Set<PhfAction["type"]>(["fold", "check", "call", "bet", "raise"]);

/** The push/fold reading of one hero decision. */
export interface PushFoldSpot {
  scenario: "push" | "call";
  /** The seats dealt in, in preflop order (first to act first, the big blind last). */
  order: number[];
  hero: number;
  pusher: number;
  /** What the hero did, in the game's words. */
  taken: "fold" | "push" | "call";
  players: PushFoldPlayer[];
  effBb: number;
}

/** The dealt-in seats in preflop order: clockwise from the seat after the big blind's, the big blind last. */
function preflopOrder(seats: readonly number[], bigBlind: number): number[] {
  const sorted = [...seats].sort((a, b) => a - b);
  const after = sorted.filter((seat) => seat > bigBlind);
  const before = sorted.filter((seat) => seat < bigBlind);
  return [...after, ...before, bigBlind];
}

/**
 * Reads one hero preflop decision as a decision of the push/fold game, or
 * says why it is not one.
 */
export function pushFoldSpot(hand: PhfHand, context: StatsContext, hero: number, spot: Spot): PushFoldSpot | { reason: TournamentSkipReason } {
  if (spot.street !== "preflop") return { reason: "tournament-postflop" };
  const bb = Math.max(1, hand.game.bigBlind);
  const seats = context.dealtInSeats;
  if (seats.length > MAX_PLAYERS) return { reason: "tournament-players" };
  const posts = new Map<number, { dead: number; live: number }>();
  let bigBlindSeat: number | null = null;
  for (const action of hand.actions) {
    if (action.street !== "preflop" || action.seat === null) continue;
    if (action.type === "straddle" || action.type === "post" || action.type === "missed-blind" || action.type === "bomb-ante") {
      return { reason: "tournament-not-push-fold" };
    }
    const entry = posts.get(action.seat) ?? { dead: 0, live: 0 };
    if (action.type === "ante") entry.dead += action.amount;
    else if (action.type === "small-blind" || action.type === "big-blind") entry.live += action.amount;
    else continue;
    posts.set(action.seat, entry);
    if (action.type === "big-blind" && bigBlindSeat === null) bigBlindSeat = action.seat;
  }
  if (bigBlindSeat === null || !seats.includes(bigBlindSeat) || seats.length < 2) return { reason: "tournament-not-push-fold" };
  const order = preflopOrder(seats, bigBlindSeat);
  const players: PushFoldPlayer[] = order.map((seat) => ({
    stack: context.players.get(seat)?.startingStack ?? 0,
    dead: posts.get(seat)?.dead ?? 0,
    live: posts.get(seat)?.live ?? 0,
  }));
  const heroAt = order.indexOf(hero);
  if (heroAt < 0) return { reason: "tournament-not-push-fold" };

  // The decisions in front of the hero's: folds, and at most one all-in first in.
  let pusher = -1;
  for (const action of hand.actions) {
    if (action.index >= spot.action.index) break;
    if (action.street !== "preflop" || action.seat === null || !DECISION_TYPES.has(action.type)) continue;
    if (action.type === "fold") continue;
    const allInFirst = pusher < 0 && action.allIn && (action.type === "raise" || action.type === "bet" || action.type === "call");
    if (!allInFirst) return { reason: "tournament-not-push-fold" };
    pusher = order.indexOf(action.seat);
    if (pusher < 0) return { reason: "tournament-not-push-fold" };
  }
  const type = spot.action.type;
  const heroAllIn = spot.action.allIn;
  let taken: PushFoldSpot["taken"];
  if (pusher < 0) {
    if (type === "fold") taken = "fold";
    else if (heroAllIn && (type === "raise" || type === "bet" || type === "call")) taken = "push";
    else return { reason: "tournament-not-push-fold" };
    if (heroAt === order.length - 1) return { reason: "tournament-not-push-fold" };
  } else {
    if (pusher >= heroAt) return { reason: "tournament-not-push-fold" };
    if (type === "fold") taken = "fold";
    else if (type === "call") taken = "call";
    else return { reason: "tournament-not-push-fold" };
  }
  if (!pushFoldPlayable({ players, value: () => new Float64Array(0) })) return { reason: "tournament-posted-all-in" };

  const stackOf = (x: number) => players[x].stack;
  const effective =
    pusher < 0
      ? Math.min(stackOf(heroAt), Math.max(...players.slice(heroAt + 1).map((p) => p.stack)))
      : Math.min(stackOf(heroAt), stackOf(pusher));
  const effBb = effective / bb;
  if (effBb > PUSH_FOLD_MAX_BB) return { reason: "tournament-deep" };
  // A caller with players still behind them and less than half the push behind: their call leaves a side pot
  // the others would contest, which the one-caller game cannot read (it would let a 0.3bb stack end the action).
  const first = pusher < 0 ? heroAt : pusher;
  const behindOf = (x: number) => players[x].stack - players[x].dead;
  for (let x = first + 1; x < order.length - 1; x += 1) {
    if (behindOf(x) < SIDE_POT_SHARE * behindOf(first)) return { reason: "tournament-side-pot" };
  }
  return { scenario: pusher < 0 ? "push" : "call", order, hero: heroAt, pusher: pusher < 0 ? heroAt : pusher, taken, players, effBb };
}

/* ---------------------------------------------------------------- value - */

/** The payoff of the game's ends: prize equity over everyone left, or chips. */
interface Payoff {
  value: (stacks: Float64Array) => Float64Array;
  /** The whole stack vector ICM reads, from the game's stacks. */
  full: (stacks: ArrayLike<number>) => number[];
  /** Index of each game player in `full`'s vector. */
  index: number[];
  prizes: number[];
  /** Share of the pool (or of the chips) one chip is worth, on average. */
  chipPrice: number;
  method: IcmFacts["method"];
  icmError: number | null;
}

function payoffOf(hand: PhfHand, order: readonly number[], model: TournamentModel): Payoff {
  // The table's players who were not dealt in keep their stacks; the players at other tables theirs.
  const dealt = new Set(order);
  const idle = tableStacks(hand).filter((p) => !dealt.has(p.seat)).map((p) => p.stack);
  const away = model.others ? new Array<number>(model.others.count).fill(model.others.stack) : [];
  const fixed = [...idle, ...away];
  const full = (stacks: ArrayLike<number>) => [...Array.from(stacks), ...fixed];
  const index = order.map((_, x) => x);
  const startTotal = full(order.map((seat) => hand.players.find((p) => p.seat === seat)?.startingStack ?? 0)).reduce((a, b) => a + b, 0);
  const prizes = remainingPrizes(model);
  if (model.model === "chips" || prizes.length === 0) {
    return {
      value: (stacks) => {
        const total = full(stacks).reduce((a, b) => a + b, 0);
        return stacks.map((s) => (total > 0 ? s / total : 0));
      },
      full,
      index,
      prizes: [],
      chipPrice: startTotal > 0 ? 1 / startTotal : 0,
      method: "chips",
      icmError: null,
    };
  }
  const pool = prizes.reduce((a, b) => a + b, 0);
  let method: IcmFacts["method"] = "exact";
  let icmError = 0;
  const value = (stacks: Float64Array) => {
    const result: IcmResult = icm(full(stacks), prizes);
    if (result.method === "monte-carlo") {
      method = "monte-carlo";
      icmError = Math.max(icmError, result.errorBound);
    }
    return Float64Array.from(index, (x) => result.equity[x]);
  };
  return {
    value,
    full,
    index,
    prizes,
    chipPrice: startTotal > 0 ? pool / startTotal : 0,
    get method() {
      return method;
    },
    get icmError() {
      return method === "monte-carlo" ? icmError : null;
    },
  };
}

/* ---------------------------------------------------------------- grade - */

export type PushFoldGrade =
  | ({ ok: true; options: OptionAnalysis[]; chosen: number; approximations: Approximation[]; icm: IcmFacts } & GradeResult)
  | { ok: false; reason: TournamentSkipReason };

/** The 2-, 6- or 9-seat chart table a game of `k` players reads as (earliest seats folded), or null. */
function chartTable(k: number): { set: string; size: number } | null {
  if (k === 2) return { set: "icm-pushfold-hu", size: 2 };
  if (k >= 3 && k <= 6) return { set: "icm-pushfold-6max", size: 6 };
  if (k >= 7 && k <= 9) return { set: "icm-pushfold-9max", size: 9 };
  return null;
}

/**
 * Grades one hero preflop decision of a tournament hand by the push/fold
 * game, or says why it cannot. `settings` are the user's for this tournament.
 */
export function gradePushFold(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  spot: Spot,
  potBb: number,
  settings: TournamentSettings | null,
): PushFoldGrade {
  const found = pushFoldSpot(hand, context, hero, spot);
  if ("reason" in found) return { ok: false, reason: found.reason };
  const cards = context.players.get(hero)?.holeCards ?? [];
  const cls = classByName(handClass([...cards]) ?? "");
  if (cls < 0) return { ok: false, reason: "tournament-not-push-fold" };

  const model = tournamentModel(hand, settings);
  const payoff = payoffOf(hand, found.order, model);
  const game: PushFoldGame = { players: found.players, value: payoff.value };
  const solution = solvePushFold(game, found.pusher);
  const values = found.scenario === "push" ? pushValues(game, solution, found.hero, cls) : callValues(game, solution, found.pusher, found.hero, cls);

  const bb = Math.max(1, hand.game.bigBlind);
  const start = payoff.value(Float64Array.from(found.players, (p) => p.stack))[found.hero];
  const toBb = (equity: number) => (payoff.chipPrice > 0 ? (equity - start) / payoff.chipPrice / bb : 0);
  // `sizeBb` as a chart writes it: what the hero has in after the action, antes aside.
  const live = (x: number) => found.players[x].stack - found.players[x].dead;
  const act: OptionAnalysis =
    found.scenario === "push"
      ? { action: "raise", allIn: true, sizeBb: round2(live(found.hero) / bb), freq: round4(values.freq), ev: round3(toBb(values.act)) }
      : {
          action: "call",
          sizeBb: round2(Math.min(live(found.hero), live(found.pusher)) / bb),
          freq: round4(values.freq),
          ev: round3(toBb(values.act)),
        };
  const fold: OptionAnalysis = {
    action: "fold",
    sizeBb: round2(found.players[found.hero].live / bb),
    freq: round4(1 - values.freq),
    ev: round3(toBb(values.fold)),
  };
  const options = [fold, act];
  const chosen = found.taken === "fold" ? 0 : 1;
  const result = grade({ options, chosen, pot: potBb });

  // Who could still call after the push, and the hero's matchup with each.
  const k = found.order.length;
  const startStacks = payoff.full(found.players.map((p) => p.stack));
  const position = (x: number) => (context.position.get(found.order[x]) ?? null) as Position | null;
  const players: IcmFacts["players"] = [];
  for (let x = found.pusher + 1; x < k; x += 1) {
    const vs = found.scenario === "push" ? x : x === found.hero ? null : x;
    let bubbleFactor: number | null = null;
    let riskPremium: number | null = null;
    if (vs !== null && found.scenario === "push") {
      if (payoff.prizes.length > 0) {
        const price = allInPrice(startStacks, payoff.prizes, found.hero, vs);
        bubbleFactor = price && Number.isFinite(price.bubbleFactor) ? round3(price.bubbleFactor) : null;
        riskPremium = price ? round4(price.riskPremium) : null;
      } else {
        bubbleFactor = 1;
        riskPremium = 0;
      }
    }
    players.push({ seat: found.order[x], position: position(x), callShare: round4(rangeShare(solution.call[found.pusher][x])), bubbleFactor, riskPremium });
  }
  if (found.scenario === "call") {
    // The hero against the pusher.
    const entry = players.find((p) => p.seat === found.order[found.hero]);
    let bubbleFactor: number | null = 1;
    let riskPremium: number | null = 0;
    if (payoff.prizes.length > 0) {
      const price = allInPrice(startStacks, payoff.prizes, found.hero, found.pusher);
      bubbleFactor = price && Number.isFinite(price.bubbleFactor) ? round3(price.bubbleFactor) : null;
      riskPremium = price ? round4(price.riskPremium) : null;
    }
    if (entry) {
      entry.bubbleFactor = bubbleFactor;
      entry.riskPremium = riskPremium;
    }
  }

  const approximations = new Set<Approximation>(["push-fold"]);
  const behind = k - 1 - found.hero;
  if ((found.scenario === "push" && behind >= 2) || (found.scenario === "call" && behind >= 1)) approximations.add("one-caller");
  if (payoff.method === "chips") approximations.add("icm-chip-ev");
  else {
    if (model.payoutsSource === "standard") approximations.add("icm-payouts-assumed");
    if (model.playersLeftSource === "user") approximations.add("icm-players-left");
    if (model.others) approximations.add("icm-field-average");
    if (payoff.method === "monte-carlo") approximations.add("icm-monte-carlo");
  }

  const table = chartTable(k);
  const chart = table
    ? {
        set: table.set,
        line:
          "f".repeat(table.size - k) +
          found.order
            .slice(0, found.hero)
            .map((_, x) => (x === found.pusher && found.scenario === "call" ? "a" : "f"))
            .join(""),
      }
    : null;

  const icmFacts: IcmFacts = {
    model: payoff.method === "chips" ? "chips" : "icm",
    chipsReason: payoff.method === "chips" ? (model.chipsReason ?? "payouts-unknown") : null,
    key: model.key,
    kind: model.kind,
    kindSource: model.kindSource,
    payouts: payoff.prizes.length > 0 ? payoff.prizes.map((z) => round4(z * 100)) : null,
    payoutsSource: payoff.prizes.length > 0 ? model.payoutsSource : null,
    playersLeft: model.playersLeft,
    playersLeftSource: model.playersLeftSource,
    entrants: model.entrants,
    entrantsSource: model.entrantsSource,
    prizePool: model.prizePool,
    method: payoff.method,
    icmError: payoff.icmError === null ? null : round6(payoff.icmError),
    stacks: tableStacks(hand).map((p) => ({
      seat: p.seat,
      position: (context.position.get(p.seat) ?? null) as Position | null,
      stackBb: round2(p.stack / bb),
      hero: p.seat === hero,
    })),
    others: model.others && payoff.method !== "chips" ? { count: model.others.count, stackBb: round2(model.others.stack / bb), source: model.others.source } : null,
    scenario: found.scenario,
    pusher: found.scenario === "call" ? position(found.pusher) : null,
    effBb: round2(found.effBb),
    equity: { start: round6(start), options: [round6(values.fold), round6(values.act)] },
    bbValue: round6(payoff.chipPrice * bb),
    pushShare: round4(rangeShare(solution.push[found.pusher])),
    players,
    iterations: solution.iterations,
    gapBb: round3(payoff.chipPrice > 0 ? solution.gap / payoff.chipPrice / bb : 0),
    chart,
  };

  return {
    ok: true,
    options,
    chosen,
    approximations: [...approximations].sort(),
    icm: icmFacts,
    grade: result.grade,
    evLoss: round3(result.evLoss),
    evLossPot: Number.isFinite(result.evLossPot) ? round4(result.evLossPot) : 1,
    freqDiff: round4(result.freqDiff),
    score: round2(result.score),
  };
}

/** The class names, for the hand view's range grid. */
export const PUSH_FOLD_CLASSES = HAND_CLASSES.map((c) => c.name);
