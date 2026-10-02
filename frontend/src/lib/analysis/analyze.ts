/**
 * `PhfHand` → `HandAnalysis`. The entry point.
 *
 * ```
 * buildContext (lib/stats) ─▶ heroSpots (walk.ts) ─▶ facts (texture.ts, ranges.ts, lib/equity)
 *                                                  ├▶ preflop: gradePreflop (preflop.ts, lib/charts)
 *                                                  └▶ heuristicFlags (heuristics.ts)
 * ```
 *
 * **Preflop is graded from the charts (A2b).** Each hero preflop decision is
 * looked up; a node gives options, a grade and an EV loss (`source: "chart"`),
 * a refusal makes the decision `not-analysed` with the lookup's reason.
 * Postflop decisions stay heuristic: flags, never grades. Opponents' ranges
 * for the equity facts come from the charts where their line has a node, and
 * from `ranges.ts`'s labelled placeholders where it does not.
 *
 * Deterministic: the same document gives the same analysis, bit for bit,
 * including every sampled equity (the seed is fixed per decision). That is what
 * lets a stored row be trusted after the fact and what makes "re-run the
 * analysis" a no-op rather than a reshuffle.
 *
 * **What is analysed (§3.5, §8).** v1 covers No-Limit Hold'em cash. A hand
 * outside that is `not-analysed` with its reason; inside it, a postflop
 * decision in a multiway pot is skipped (`partial`), because nothing here — and
 * nothing the solver phases build — models three ranges at once. Saying nothing
 * is better than saying something wrong, and the reader is told which it was.
 */

import { handClass } from "../cards";
import type { ChartSet } from "../charts";
import { equityVsRange, parseRange, strongestOfRange, type ClassWeights } from "../equity/range";
import type { PhfHand, Position } from "../phf/types";
import { buildContext, type StatsContext } from "../stats/context";
import { potTypeOf } from "../stats/derive";
import { worstGrade, worstSeverity, meanScore } from "./grading";
import { heuristicFlags } from "./heuristics";
import { chartRange, gradePreflop } from "./preflop";
import { defaultRange, preflopLine } from "./ranges";
import { blockers, boardTexture, draws, madeHand, toIndices } from "./texture";
import {
  ANALYSIS_VERSION,
  type Approximation,
  type DecisionAnalysis,
  type DecisionStreet,
  type HandAnalysis,
  type HandSkipReason,
  type PostflopFacing,
  type PostflopRole,
  type PreflopScenario,
  type SpotFacts,
} from "./types";
import { heroSpots, type Spot } from "./walk";

export interface AnalyzeOptions {
  /**
   * Compute equities (against the placeholder ranges, and the nut checks
   * against any two cards). On by default; off makes the analysis cheap enough
   * to run in a render, at the cost of every check that needs an equity.
   */
  equity?: boolean;
  /** Base seed for sampled equities. Each decision offsets it by its order. */
  seed?: number;
  /**
   * The preflop chart set (`loadDefaultCharts()` from `lib/charts`). Without
   * it every preflop decision is `not-analysed / chart-unavailable` and the
   * equity facts use the placeholder ranges — never what the rebuild stores.
   */
  charts?: ChartSet | null;
}

/** 100bb ±20% (§8): outside this the stack depth is an approximation. */
const STACK_LOW_BB = 80;
const STACK_HIGH_BB = 120;
const SIX_MAX = 6;
const ANALYSIS_SEED = 0xa1a1;
/**
 * The share of a range a river bettor is assumed to hold at the least. See
 * `SpotFacts.equity.strong`. A quarter, not a half: measured on the corpus, a
 * half still called a fold of top pair to a pot-sized river bet "a fold with
 * odds", and a check that cries wolf is worse than no check.
 */
const STRONG_SHARE = 0.25;

const ANY_TWO: ClassWeights = parseRange("*");

const round2 = (value: number) => Math.round(value * 100) / 100;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

type ResolvedOptions = Required<Omit<AnalyzeOptions, "charts">> & { charts: ChartSet | null };
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The hero seat, as the stats engine sees it: a dealt-in seat whose player is the hero. */
export function heroSeatOf(context: StatsContext): number | null {
  for (const seat of context.dealtInSeats) {
    if (context.players.get(seat)?.isHero) {
      return seat;
    }
  }
  return null;
}

function handSkip(hand: PhfHand, context: StatsContext, hero: number | null): HandSkipReason | null {
  if (hero === null) return "no-hero";
  if (hand.game.variant !== "holdem") return "variant";
  if (hand.game.hiLo) return "hi-lo";
  if (hand.game.limit !== "nl") return "limit";
  if (hand.game.format !== "cash") return "tournament";
  if (context.isBombPot) return "bomb-pot";
  const cards = context.players.get(hero)?.holeCards ?? [];
  if (cards.length !== 2 || toSafeIndices(cards) === null) return "hero-cards-unknown";
  return null;
}

function toSafeIndices(cards: readonly string[]): number[] | null {
  try {
    return toIndices(cards);
  } catch {
    return null;
  }
}

function emptyAnalysis(reason: HandSkipReason, hero: number | null, potType: string): HandAnalysis {
  return {
    version: ANALYSIS_VERSION,
    status: "not-analysed",
    reason,
    heroSeat: hero,
    potType,
    grade: null,
    score: null,
    evLoss: null,
    evLossPot: null,
    decisions: [],
    approximations: [],
    flagCount: 0,
    worstFlag: null,
  };
}

/* ------------------------------------------------------------- scenarios - */

function preflopScenario(spot: Spot, context: StatsContext, hero: number): PreflopScenario {
  const decision = spot.decision;
  const level = decision.raisesBefore;
  if (level === 0) {
    if (spot.toCall === 0) return "bb-option";
    return decision.enteredBefore.length > 0 ? "vs-limp" : "unopened";
  }
  if (level === 1) {
    const heroIn = decision.enteredBefore.includes(hero);
    return decision.callersSinceAggression > 0 && !heroIn ? "squeeze" : "vs-open";
  }
  if (level === 2) {
    const heroRaised = (context.byStreet.get("preflop") ?? []).some(
      (other) => other.seat === hero && other.type === "raise" && other.order < decision.order,
    );
    return heroRaised ? "vs-3bet" : "vs-3bet-cold";
  }
  return "vs-4bet";
}

function postflopRole(context: StatsContext, hero: number): PostflopRole {
  if (context.preflopAggressor === null) return "limped";
  return context.preflopAggressor === hero ? "pfr" : "caller";
}

function postflopFacing(spot: Spot): PostflopFacing {
  if (spot.decision.aggressionBefore === 0) return "first";
  return spot.decision.raisesBefore > 0 ? "vs-raise" : "vs-bet";
}

/** Stack depth in coarse buckets, for the node key. */
function stackBucket(bb: number): string {
  const buckets = [20, 40, 60, 80, 100, 150, 200, 300];
  for (const bucket of buckets) {
    if (bb <= bucket * 1.1) return `${bucket}`;
  }
  return "300+";
}

/* ---------------------------------------------------------------- facts - */

interface BuiltFacts {
  facts: SpotFacts;
  cannotLose: boolean;
  beatsNoHolding: boolean;
  noMoreCards: boolean;
}

/**
 * The opponent an equity is measured against: heads-up, the one opponent;
 * preflop facing an all-in, the seat whose bet the hero is answering.
 */
function villainOf(spot: Spot, context: StatsContext): number | null {
  if (spot.opponents.length === 1) return spot.opponents[0].seat;
  if (spot.street !== "preflop") return null;
  // The last raiser before the hero's decision.
  let last: number | null = null;
  for (const decision of context.byStreet.get("preflop") ?? []) {
    if (decision.order >= spot.decision.order) break;
    if (decision.type === "raise") last = decision.seat;
  }
  return last;
}

function buildFacts(
  spot: Spot,
  context: StatsContext,
  hero: number,
  multiway: boolean,
  options: ResolvedOptions,
): BuiltFacts {
  const hand = context.hand;
  const bb = Math.max(1, hand.game.bigBlind);
  const toBb = (value: number) => round2(value / bb);
  const holeCodes = context.players.get(hero)?.holeCards ?? [];
  const hole = toIndices(holeCodes);
  const board = toIndices(spot.board);
  const street = spot.street as DecisionStreet;
  const postflop = street !== "preflop";
  const role = postflop ? postflopRole(context, hero) : null;
  const facing = postflop ? postflopFacing(spot) : null;
  const preflopScenarioValue = postflop ? null : preflopScenario(spot, context, hero);
  const scenario = postflop
    ? `${role}-${spot.inPosition ? "ip" : "oop"}-${facing}`
    : (preflopScenarioValue as string);

  const toCall = spot.toCall;
  // An unopened pot has a price (the big blind) but no bet in it: the pot odds
  // of "calling" the blind are not a fact anyone reasons about, and an MDF
  // against a blind is meaningless. Everything else facing chips is a bet.
  const facingBet = toCall > 0 && preflopScenarioValue !== "unopened";
  const potOdds = facingBet ? round3(toCall / (spot.potBefore + toCall)) : null;
  // MDF is a postflop idea: preflop, folding most of a range to an open is
  // simply correct, and the reference there is a chart (A2), not the price.
  const mdf = facingBet && postflop && spot.potBefore > 0 ? round3(1 - toCall / spot.potBefore) : null;
  const facingPot = facingBet && spot.potBefore - toCall > 0 ? round3(toCall / (spot.potBefore - toCall)) : null;
  const action = spot.decision.type;
  let betPot: number | null = null;
  if (action === "bet" && spot.potBefore > 0) {
    betPot = round3(spot.amount / spot.potBefore);
  } else if (action === "raise") {
    // The raise over the call, against the pot once the call is in.
    const over = spot.streetTotalAfter - spot.streetHigh;
    const after = spot.potBefore + toCall;
    betPot = after > 0 ? round3(Math.max(0, over) / after) : null;
  }
  const behind = action === "bet" || action === "raise" ? spot.heroBehind - spot.amount : null;

  const made = postflop ? madeHand(hole, board) : null;
  let cannotLose = false;
  let beatsNoHolding = false;
  let equity: SpotFacts["equity"] = null;

  const opponentAllIn = spot.opponents.length > 0 && spot.opponents.every((opponent) => opponent.allIn);
  const callAllIn = toCall > 0 && toCall >= spot.heroBehind;
  const noMoreCards = street === "river" || opponentAllIn || callAllIn;

  if (options.equity && !multiway) {
    const seed = options.seed + spot.decision.order;
    // The nut checks are against any two cards, so they are certainties rather
    // than estimates. Cheap on the river (~1,000 combos) and the turn (x44);
    // on the flop only a hand that could plausibly be unbeatable is checked.
    const nutCandidate =
      street === "river" ||
      (postflop &&
        (street === "turn" ||
          made?.class === "straight-flush" ||
          made?.class === "quads" ||
          made?.class === "full-house"));
    if (postflop && made && nutCandidate && (action === "fold" || street === "river")) {
      const any = equityVsRange({
        hero: holeCodes,
        range: ANY_TWO,
        board: spot.board,
        method: "exhaustive",
      });
      cannotLose = any.combos > 0 && any.win + any.tie >= 1 - 1e-12;
      beatsNoHolding = any.combos > 0 && any.win + any.tie <= 1e-12;
      made.nuts = street === "river" && cannotLose;
    }

    // An equity against the placeholder range, wherever a price is being
    // judged: facing a bet after the flop, or facing an all-in before it.
    const villain = villainOf(spot, context);
    const wantEquity = villain !== null && toCall > 0 && (postflop || opponentAllIn || callAllIn);
    if (wantEquity && villain !== null) {
      const line = preflopLine(context, villain);
      const villainPosition = context.position.get(villain) ?? null;
      // The charts' range for the villain's line where a node exists; the
      // labelled placeholder where it does not.
      const fromCharts = chartRange(hand, villain, spot.action.index, options.charts);
      const range = fromCharts ? fromCharts.range : defaultRange(line, villainPosition).range;
      const result = equityVsRange({ hero: holeCodes, range, board: spot.board, seed });
      if (result.combos > 0) {
        let strong: number | null = null;
        if (street === "river") {
          const top = strongestOfRange(range, spot.board, STRONG_SHARE, holeCodes);
          strong = round3(equityVsRange({ hero: holeCodes, range: top, board: spot.board, seed }).equity);
        }
        equity = {
          value: round3(result.equity),
          range: `${line}:${villainPosition ?? "?"}`,
          source: fromCharts ? "chart" : "placeholder",
          combos: result.combos,
          method: result.method,
          strong,
        };
      }
    }
  }

  const facts: SpotFacts = {
    street,
    position: (context.position.get(hero) ?? null) as Position | null,
    inPosition: postflop && !multiway ? spot.inPosition : null,
    players: spot.opponents.length + 1,
    scenario,
    preflopScenario: preflopScenarioValue,
    role,
    facing,
    potBb: toBb(spot.potBefore),
    toCallBb: toBb(toCall),
    heroStackBb: toBb(spot.heroBehind),
    effStackBb: toBb(spot.effBehind),
    spr: postflop && spot.streetPot > 0 ? round2(spot.streetEffBehind / spot.streetPot) : null,
    potOdds,
    mdf,
    facingPot,
    betPot,
    behindBb: behind === null ? null : toBb(Math.max(0, behind)),
    allIn: spot.action.allIn,
    holeCards: [...holeCodes],
    handClass: handClass([...holeCodes]),
    board: [...spot.board],
    texture: postflop ? boardTexture(board) : null,
    made,
    draws: postflop ? draws(hole, board) : [],
    blockers: postflop ? blockers(hole, board) : [],
    equity,
    chart: null,
  };
  return { facts, cannotLose, beatsNoHolding, noMoreCards };
}

/* -------------------------------------------------------------- analyse - */

/**
 * Analyses the hero's decisions in one hand.
 *
 * Never throws for a hand the converter accepted: anything it cannot read is a
 * `not-analysed` reason. (A malformed card on the hero is
 * `hero-cards-unknown`; an equity the engine refuses leaves that one fact
 * null.) The caller decides whether to store the result; this only describes.
 */
export function analyzeHand(hand: PhfHand, options: AnalyzeOptions = {}): HandAnalysis {
  const resolved: ResolvedOptions = {
    equity: options.equity ?? true,
    seed: options.seed ?? ANALYSIS_SEED,
    charts: options.charts ?? null,
  };
  const context = buildContext(hand);
  const hero = heroSeatOf(context);
  const skip = handSkip(hand, context, hero);
  const potType = potTypeOf(context);
  if (skip !== null || hero === null) {
    return emptyAnalysis(skip ?? "no-hero", hero, potType);
  }

  const spots = heroSpots(context, hero);
  if (spots.length === 0) {
    return emptyAnalysis("no-decisions", hero, potType);
  }

  // Hand-level approximations (§3.5): what the reference does not model.
  const bb = Math.max(1, hand.game.bigBlind);
  const handApprox = new Set<Approximation>();
  if (context.anteModel !== "none") handApprox.add("antes");
  if (context.hasStraddle) handApprox.add("straddle");
  if (hand.table.maxSeats !== SIX_MAX) handApprox.add("table-size");
  const heroStack = context.players.get(hero)?.startingStack ?? 0;
  const deepestOther = Math.max(
    0,
    ...context.dealtInSeats.filter((seat) => seat !== hero).map((seat) => context.players.get(seat)?.startingStack ?? 0),
  );
  const effectiveBb = Math.min(heroStack, deepestOther) / bb;
  if (effectiveBb < STACK_LOW_BB || effectiveBb > STACK_HIGH_BB) handApprox.add("stack-depth");

  let preflopSeen = 0;
  const decisions: DecisionAnalysis[] = spots.map((spot) => {
    const street = spot.street as DecisionStreet;
    const multiway = street !== "preflop" && spot.opponents.length >= 2;
    const preflopNth = street === "preflop" ? preflopSeen++ : -1;
    let built: BuiltFacts;
    try {
      built = buildFacts(spot, context, hero, multiway, resolved);
    } catch {
      // An equity request the engine refuses (a card dealt twice by a broken
      // export) must not cost the decision its other facts.
      built = buildFacts(spot, context, hero, multiway, { ...resolved, equity: false });
    }
    const { facts } = built;
    const approximations = new Set<Approximation>(handApprox);
    if (facts.equity) approximations.add(facts.equity.source === "chart" ? "preflop-range" : "placeholder-range");

    // Preflop: the charts, or the reason they cannot answer.
    const chart =
      street === "preflop"
        ? gradePreflop(
            { hand, heroSeat: hero, nth: preflopNth, actionIndex: spot.action.index, potBb: facts.potBb },
            resolved.charts,
          )
        : null;
    const skipped = multiway ? "multiway" : chart && !chart.ok ? chart.reason : null;
    if (chart?.ok) {
      // The chart lookup judged stack depth and table size itself (it refuses
      // outside its cover and notes what it approximates), so the hand-level
      // versions of those two give way to its own.
      approximations.delete("stack-depth");
      approximations.delete("table-size");
      for (const value of chart.approximations) approximations.add(value);
      facts.chart = chart.chart;
    } else {
      approximations.add("heuristic");
    }

    // A preflop line the charts refuse keeps its heuristic flags: they hold
    // whatever the strategy (§3.6), and "you folded when a check was free"
    // is as true on a 9-max table as on a 6-max one. A multiway postflop
    // decision does not: every equity check there assumes one opponent.
    const flags = multiway
      ? []
      : heuristicFlags({
          spot,
          facts,
          cannotLose: built.cannotLose,
          beatsNoHolding: built.beatsNoHolding,
          noMoreCards: built.noMoreCards,
          startingStack: heroStack,
          bigBlind: bb,
        });

    return {
      order: spot.decision.order,
      actionIndex: spot.action.index,
      street,
      action: spot.decision.type as DecisionAnalysis["action"],
      status: skipped ? "not-analysed" : "analysed",
      reason: skipped,
      node: [
        "nlhe",
        hand.game.format,
        `${hand.table.maxSeats}max`,
        `${stackBucket(effectiveBb)}bb`,
        potType,
        street,
        facts.scenario,
        facts.position ?? "?",
      ].join("/"),
      options: chart?.ok ? chart.options : [],
      chosen: chart?.ok ? chart.chosen : null,
      evLoss: chart?.ok ? chart.evLoss : null,
      evLossPot: chart?.ok ? chart.evLossPot : null,
      freqDiff: chart?.ok ? chart.freqDiff : null,
      grade: chart?.ok ? chart.grade : null,
      score: chart?.ok ? chart.score : null,
      source: chart?.ok ? "chart" : "heuristic",
      approximations: [...approximations].sort(),
      facts,
      flags,
      worstFlag: worstSeverity(flags.map((flag) => flag.severity)),
    };
  });

  const analysed = decisions.filter((decision) => decision.status === "analysed");
  const allApprox = new Set<Approximation>();
  for (const decision of analysed) for (const value of decision.approximations) allApprox.add(value);
  const flagCount = decisions.reduce((sum, decision) => sum + decision.flags.length, 0);

  // §1: the hand's EV loss is the sum over its graded decisions, and its share
  // of the pot is that sum over the final pot.
  const graded = decisions.filter((decision) => decision.evLoss !== null);
  const evLoss = graded.length > 0 ? round3(graded.reduce((sum, decision) => sum + (decision.evLoss ?? 0), 0)) : null;
  const finalPotBb = Math.max(hand.results.totalPot / bb, ...decisions.map((decision) => decision.facts.potBb));
  const score = meanScore(decisions.map((decision) => decision.score));

  return {
    version: ANALYSIS_VERSION,
    status: analysed.length === 0 ? "not-analysed" : analysed.length === decisions.length ? "full" : "partial",
    reason: analysed.length === 0 ? (decisions[0].reason ?? "multiway") : null,
    heroSeat: hero,
    potType,
    grade: worstGrade(decisions.map((decision) => decision.grade)),
    score: score === null ? null : round2(score),
    evLoss,
    evLossPot: evLoss === null ? null : finalPotBb > 0 ? round4(evLoss / finalPotBb) : 0,
    decisions,
    approximations: [...allApprox].sort(),
    flagCount,
    worstFlag: worstSeverity(decisions.map((decision) => decision.worstFlag)),
  };
}
