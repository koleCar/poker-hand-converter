/**
 * `PhfHand` → `HandAnalysis`. The entry point.
 *
 * ```
 * buildContext (lib/stats) ─▶ heroSpots (walk.ts) ─▶ facts (texture.ts, ranges.ts, lib/equity)
 *                                                  ├▶ preflop: gradePreflop (preflop.ts, lib/charts)
 *                          walkRanges (rangeWalk.ts) ├▶ river: solveRiverSpot → gradeRiver (river.ts, lib/solver)
 *                                                  └▶ heuristicFlags (heuristics.ts)
 * ```
 *
 * **Preflop is graded from the charts (A2b).** Each hero preflop decision is
 * looked up; a node gives options, a grade and an EV loss (`source: "chart"`),
 * a refusal makes the decision `not-analysed` with the lookup's reason.
 *
 * **The river is graded by our solver (A4)** in a heads-up pot: both ranges
 * are walked from preflop through the flop and turn (`rangeWalk.ts`, a
 * heuristic narrowing model until A5), the river is solved once per hand, and
 * each hero river decision reads its combo's strategy and EVs at its node
 * (`source: "solver"`). A river the solver cannot take is `not-analysed` with
 * a `river-*` reason. The flop and turn stay heuristic: flags, never grades,
 * but their equity facts are now against the narrowed range.
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
import { equityVsRange, parseRange, strongestOfRange, type ClassWeights, type WeightedCombo } from "../equity/range";
import type { PhfHand, Position } from "../phf/types";
import { buildContext, type StatsContext } from "../stats/context";
import { potTypeOf } from "../stats/derive";
import { worstGrade, worstSeverity, meanScore } from "./grading";
import { heuristicFlags } from "./heuristics";
import { weightedCombos } from "./narrowing";
import { chartRange, gradePreflop } from "./preflop";
import { flopSeats, walkRanges, type RangeWalk, type WalkFailure } from "./rangeWalk";
import { defaultRange, preflopLine } from "./ranges";
import {
  followLine,
  gradeRiver,
  riverActs,
  riverStudyAt,
  solveRiverSpot,
  type RiverFailure,
  type RiverGrade,
  type RiverSolve,
  type RiverStudy,
} from "./river";
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
  type RiverSkipReason,
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
  walk: RangeWalk | null,
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
      // Postflop in a heads-up pot: the villain's range narrowed by the
      // betting so far (A4). Otherwise the charts' range for the villain's
      // line where a node exists, the labelled placeholder where it does not.
      const narrowed = postflop && walk && walk.villain === villain ? walk.before(spot.action.index)?.villain : null;
      const fromCharts = narrowed ? null : chartRange(hand, villain, spot.action.index, options.charts);
      const range: ClassWeights | WeightedCombo[] = narrowed
        ? weightedCombos(narrowed)
        : fromCharts
          ? fromCharts.range
          : defaultRange(line, villainPosition).range;
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
          source: narrowed ? "narrowed" : fromCharts ? "chart" : "placeholder",
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

/* ---------------------------------------------------------------- river - */

/** The walk for a hand with postflop decisions, or why there is none. Never throws. */
function rangeWalkOf(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  charts: ChartSet | null,
): RangeWalk | { ok: false; reason: WalkFailure } {
  const seats = flopSeats(context);
  if (seats.length !== 2 || !seats.includes(hero)) return { ok: false, reason: seats.length === 0 ? "no-flop" : "multiway-flop" };
  try {
    return walkRanges(hand, context, hero, seats[0] === hero ? seats[1] : seats[0], charts);
  } catch {
    return { ok: false, reason: "range-empty" };
  }
}

const WALK_REASONS: Record<WalkFailure, RiverSkipReason> = {
  "multiway-flop": "river-multiway-flop",
  "range-unknown": "river-range-unknown",
  "range-empty": "river-range-empty",
  "no-flop": "river-range-empty",
};

export interface HandRiver {
  /** The river solve, run at most once per hand (the first call runs it). */
  solved(spot: Spot): RiverSolve | RiverFailure;
  /** Grades one hero river decision, or says why not. */
  grade(spot: Spot): RiverGrade | RiverFailure;
  /** The hero's decision node for a river spot, for the study view. */
  line(spot: Spot): { solve: RiverSolve; node: number } | RiverFailure;
}

/**
 * The hand's river, solved at most once and read at each hero river decision:
 * a hand with a check and then a call is one solve read twice.
 */
function handRiver(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  walked: RangeWalk | { ok: false; reason: WalkFailure } | null,
  charts: ChartSet | null,
  effectiveBb: number,
  potType: string,
): HandRiver {
  let cached: RiverSolve | RiverFailure | null = null;
  const acts = riverActs(hand);

  const run = (spot: Spot): RiverSolve | RiverFailure => {
    if (!walked) return { ok: false, reason: "river-range-empty", detail: "no postflop walk" };
    if (!walked.ok) return { ok: false, reason: WALK_REASONS[walked.reason], detail: walked.reason };
    if (!walked.riverStart) return { ok: false, reason: "river-range-empty", detail: "no river in the walk" };
    const bb = Math.max(1, hand.game.bigBlind);
    const cards = toIndices(context.players.get(hero)?.holeCards ?? []);
    const board = toIndices(spot.board);
    if (cards.length !== 2 || board.length !== 5) return { ok: false, reason: "river-solve-failed", detail: "cards" };
    const heroFirst = spot.inPosition === false;
    const heroPos = String(context.position.get(hero) ?? "?");
    const villainPos = String(context.position.get(walked.villain) ?? "?");
    return solveRiverSpot({
      hand,
      heroSeat: hero,
      villainSeat: walked.villain,
      heroFirst,
      heroCards: [cards[0], cards[1]],
      board,
      potBb: spot.streetPot / bb,
      stackBb: spot.streetEffBehind / bb,
      ranges: walked.riverStart,
      charts,
      model: walked.model,
      key: {
        players: hand.table.maxSeats,
        stackBucket: `${stackBucket(effectiveBb)}bb`,
        preflopLine: potType,
        positions: heroFirst ? [heroPos, villainPos] : [villainPos, heroPos],
      },
    });
  };

  const solved = (spot: Spot) => (cached ??= run(spot));

  const line = (spot: Spot): { solve: RiverSolve; node: number } | RiverFailure => {
    const solve = solved(spot);
    if (!solve.ok) return solve;
    const at = acts.findIndex((act) => act.index === spot.action.index);
    if (at < 0) return { ok: false, reason: "river-off-tree", detail: "the decision is not on the river" };
    const found = followLine(solve, acts.slice(0, at));
    return found.ok ? { solve, node: found.node } : found;
  };

  const grade = (spot: Spot): RiverGrade | RiverFailure => {
    const solve = solved(spot);
    if (!solve.ok) return solve;
    const at = acts.findIndex((act) => act.index === spot.action.index);
    if (at < 0) return { ok: false, reason: "river-off-tree", detail: "the decision is not on the river" };
    const found = followLine(solve, acts.slice(0, at));
    if (!found.ok) return found;
    return gradeRiver(solve, found, acts[at]);
  };

  return { solved, grade, line };
}

/** The equity fact of a solved river decision: against the opponent's range at the node. */
function riverEquity(solved: RiverGrade, facts: SpotFacts, walk: RangeWalk | null): SpotFacts["equity"] {
  const previous = facts.equity;
  if (!previous) return null;
  const combos = weightedCombos(solved.villainRange);
  if (combos.length === 0) return previous;
  const top = strongestOfRange(combos, facts.board, STRONG_SHARE, facts.holeCards);
  const strong = equityVsRange({ hero: facts.holeCards, range: top, board: facts.board }).equity;
  return {
    value: solved.river.heroBeats,
    range: walk?.labels.villain ?? previous.range,
    source: "solver",
    combos: solved.river.villainCombos,
    method: "exhaustive",
    strong: round3(Math.min(strong, solved.river.heroBeats)),
  };
}

/* -------------------------------------------------------------- analyse - */

/** min(hero's starting stack, the deepest other dealt-in stack), in big blinds. */
function effectiveStackBb(context: StatsContext, hero: number): number {
  const bb = Math.max(1, context.hand.game.bigBlind);
  const heroStack = context.players.get(hero)?.startingStack ?? 0;
  const deepestOther = Math.max(
    0,
    ...context.dealtInSeats.filter((seat) => seat !== hero).map((seat) => context.players.get(seat)?.startingStack ?? 0),
  );
  return Math.min(heroStack, deepestOther) / bb;
}

/**
 * The study view of one hero river decision (§6.1 *Study*): the hero's whole
 * range at the node as the solve plays it. Runs the same walk and the same
 * solve `analyzeHand` runs, so the hero's own row equals the stored options
 * bit for bit. Null when the action is not a hero river decision of a hand
 * the analysis covers; a `RiverFailure` when the solver cannot take it.
 */
export function riverStudy(
  hand: PhfHand,
  actionIndex: number,
  options: AnalyzeOptions = {},
): RiverStudy | RiverFailure | null {
  const context = buildContext(hand);
  const hero = heroSeatOf(context);
  if (hero === null || handSkip(hand, context, hero) !== null) return null;
  const spot = heroSpots(context, hero).find((s) => s.action.index === actionIndex);
  if (!spot || spot.street !== "river" || spot.opponents.length !== 1) return null;
  const charts = options.charts ?? null;
  const walked = rangeWalkOf(hand, context, hero, charts);
  const river = handRiver(hand, context, hero, walked, charts, effectiveStackBb(context, hero), potTypeOf(context));
  const found = river.line(spot);
  if (!("solve" in found)) return found;
  return riverStudyAt(found.solve, found.node);
}

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
  const effectiveBb = effectiveStackBb(context, hero);
  if (effectiveBb < STACK_LOW_BB || effectiveBb > STACK_HIGH_BB) handApprox.add("stack-depth");

  // The range walk (A4): both ranges through a heads-up hand, once.
  const walked = spots.some((spot) => spot.street !== "preflop") ? rangeWalkOf(hand, context, hero, resolved.charts) : null;
  const walk = walked && walked.ok ? walked : null;
  const river = handRiver(hand, context, hero, walked, resolved.charts, effectiveBb, potType);

  let preflopSeen = 0;
  const decisions: DecisionAnalysis[] = spots.map((spot) => {
    const street = spot.street as DecisionStreet;
    const multiway = street !== "preflop" && spot.opponents.length >= 2;
    const preflopNth = street === "preflop" ? preflopSeen++ : -1;
    let built: BuiltFacts;
    try {
      built = buildFacts(spot, context, hero, multiway, resolved, walk);
    } catch {
      // An equity request the engine refuses (a card dealt twice by a broken
      // export) must not cost the decision its other facts.
      built = buildFacts(spot, context, hero, multiway, { ...resolved, equity: false }, walk);
    }
    const { facts } = built;
    const approximations = new Set<Approximation>(handApprox);

    // River: the solver, or the reason it cannot answer.
    const solved = street === "river" && !multiway ? river.grade(spot) : null;
    if (solved?.ok) {
      facts.river = solved.river;
      if (facts.equity) {
        facts.equity = riverEquity(solved, facts, walk);
      }
    }
    if (facts.equity) {
      const source = facts.equity.source;
      if (source === "chart") approximations.add("preflop-range");
      else if (source === "placeholder") approximations.add("placeholder-range");
      else approximations.add("narrowing-heuristic");
    }
    if (walk && walk.sources.villain === "placeholder" && (solved?.ok || facts.equity?.source === "narrowed")) {
      approximations.add("placeholder-range");
    }
    if (solved?.ok && walk && walk.sources.hero === "placeholder") approximations.add("placeholder-range");

    // Preflop: the charts, or the reason they cannot answer.
    const chart =
      street === "preflop"
        ? gradePreflop(
            { hand, heroSeat: hero, nth: preflopNth, actionIndex: spot.action.index, potBb: facts.potBb },
            resolved.charts,
          )
        : null;
    const skipped = multiway
      ? "multiway"
      : chart && !chart.ok
        ? chart.reason
        : solved && !solved.ok
          ? solved.reason
          : null;
    if (solved?.ok) {
      for (const value of solved.approximations) approximations.add(value);
    } else if (chart?.ok) {
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
      options: chart?.ok ? chart.options : solved?.ok ? solved.options : [],
      chosen: chart?.ok ? chart.chosen : solved?.ok ? solved.chosen : null,
      evLoss: chart?.ok ? chart.evLoss : solved?.ok ? solved.evLoss : null,
      evLossPot: chart?.ok ? chart.evLossPot : solved?.ok ? solved.evLossPot : null,
      freqDiff: chart?.ok ? chart.freqDiff : solved?.ok ? solved.freqDiff : null,
      grade: chart?.ok ? chart.grade : solved?.ok ? solved.grade : null,
      score: chart?.ok ? chart.score : solved?.ok ? solved.score : null,
      source: chart?.ok ? "chart" : solved?.ok ? "solver" : "heuristic",
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
