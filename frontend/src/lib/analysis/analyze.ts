/**
 * `PhfHand` → `HandAnalysis`. The entry point.
 *
 * ```
 * buildContext (lib/stats) ─▶ heroSpots (walk.ts) ─▶ facts (texture.ts, ranges.ts, lib/equity)
 *                                                  ├▶ preflop: gradePreflop (preflop.ts, lib/charts)
 *                          walkRanges (rangeWalk.ts) ├▶ turn: solveTurnSpot → gradeTurn (turn.ts, lib/solver)
 *                                                  ├▶ river: solveRiverSpot → gradeRiver (river.ts), ranges from the solved turn
 *                                                  └▶ heuristicFlags (heuristics.ts)
 * ```
 *
 * **Preflop is graded from the charts (A2b).** Each hero preflop decision is
 * looked up; a node gives options, a grade and an EV loss (`source: "chart"`),
 * a refusal makes the decision `not-analysed` with the lookup's reason.
 *
 * **The river is graded by our solver (A4)** in a heads-up pot: both ranges
 * are walked from preflop through the flop and turn (`rangeWalk.ts`, a
 * a heuristic narrowing model until A5), the river is solved once per hand, and
 * each hero river decision reads its combo's strategy and EVs at its node
 * (`source: "solver"`). A river the solver cannot take is `not-analysed` with
 * a `river-*` reason.
 *
 * **The turn is graded by our solver too (A5a)**, the same way: ranges as the
 * turn card came (narrowed on the flop by the heuristic), one turn + river
 * solve per hand (`turn.ts`), `turn-*` reasons when it cannot answer. Where
 * the turn was solved and the line can be followed to the river card, the
 * river's ranges are the solved turn strategy's instead of the heuristic's
 * (`RiverFacts.narrowing`). The flop stays heuristic: flags, never grades,
 * with equity facts against the narrowed range.
 *
 * **Multiway pots (A9, `multiway.ts`).** When three or more saw the flop,
 * every player's range is walked through the hand. A turn or river that
 * began heads-up is solved exactly as above from those ranges
 * (`multiway-history`); a multiway decision gets facts against each range
 * and the field and the multiway flags; a river call or fold facing a bet
 * in a pot that was multiway gets an approximate grade by showdown EV
 * (`source: "approx"`, capped at Mistake); everything else multiway is
 * `not-analysed` with its facts and flags.
 *
 * Deterministic: the same document gives the same analysis, bit for bit,
 * including every sampled equity (the seed is fixed per decision). That is what
 * lets a stored row be trusted after the fact and what makes "re-run the
 * analysis" a no-op rather than a reshuffle.
 *
 * **What is analysed (§3.5, §8).** v1 covers No-Limit Hold'em cash. A hand
 * outside that is `not-analysed` with its reason; inside it, a multiway
 * postflop decision is graded only where an honest approximation exists (the
 * river call above) and is otherwise `not-analysed` (`partial`) with its
 * facts and notes, because no solver here models three ranges at once.
 * Saying nothing is better than saying something wrong, and the reader is
 * told which it was.
 */

import { handClass } from "../cards";
import type { ChartSet } from "../charts";
import { equityVsRange, parseRange, strongestOfRange, type ClassWeights, type WeightedCombo } from "../equity/range";
import type { PhfHand, Position } from "../phf/types";
import { buildContext, type StatsContext } from "../stats/context";
import { potTypeOf } from "../stats/derive";
import { gradeRank, worstGrade, worstSeverity, meanScore } from "./grading";
import { heuristicFlags } from "./heuristics";
import { halved, heuristicModel, weightedCombos, type NarrowingModel } from "./narrowing";
import { chartRange, gradePreflop } from "./preflop";
import { flopSeats, walkRanges, type RangeWalk, type WalkFailure } from "./rangeWalk";
import {
  gradeRiverCall,
  headsUpWalk,
  multiwayFacts,
  multiwayFlags,
  riverCallEv,
  walkMultiway,
  type ApproxGrade,
  type MultiWalk,
  type RiverCallFailure,
} from "./multiway";
import { defaultRange, preflopLine } from "./ranges";
import {
  followLine,
  gradeRiver,
  riverActs,
  riverStudyAt,
  solveRiverSpot,
  streetActs,
  type RiverFailure,
  type RiverGrade,
  type RiverSolve,
  type RiverStudy,
} from "./river";
import {
  followTurnLine,
  gradeTurn,
  riverStartFromTurn,
  solveTurnSpot,
  turnStudyAt,
  type TurnFailure,
  type TurnGrade,
  type TurnSolve,
} from "./turn";
import { OFF_TREE_DISTANCE } from "../solver";
import { blockers, boardTexture, draws, madeHand, toIndices } from "./texture";
import type { PlayerRanges } from "./rangeWalk";
import {
  ANALYSIS_VERSION,
  type Approximation,
  type DecisionAnalysis,
  type DecisionStreet,
  type HandAnalysis,
  type HandSkipReason,
  type MultiwayFacts,
  type MultiwaySkipReason,
  type PostflopFacing,
  type PostflopRole,
  type PreflopScenario,
  type RiverSkipReason,
  type SpotFacts,
  type TurnSkipReason,
} from "./types";
import { heroSpots, type Spot } from "./walk";
import {
  gradeFlop,
  libraryEntry,
  libraryModel,
  type FlopEntry,
  type FlopGrade,
  type FlopLibrary,
  type LibraryModel,
} from "./flopLibrary";

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
  /**
   * Analyse only the hero decision at this `PhfAction.index` (the trainer,
   * phase A7): the same walk, facts, grade, caps and sensitivity check a full
   * run gives that decision, without paying for the hand's other decisions.
   * The hand-level fields then describe that one decision.
   */
  only?: number | null;
  /**
   * Solve heads-up turns (A5a). On by default, and always on in the rebuild.
   * Off reproduces A4's handling - turn decisions keep their facts and flags
   * without a grade, and the river's ranges come from the heuristic all the
   * way - so a test can sweep thousands of hands without a turn solve each.
   */
  turn?: boolean;
  /**
   * The flop library (A5b): where a hand's line and flop have a chunk, the
   * flop's ranges are narrowed by its solved strategies and the hero's flop
   * decisions are graded from it (`flopLibrary.ts`). Absent - the default,
   * and always while `FLOP_LIBRARY_ENABLED` is off - the flop is heuristic.
   */
  flopLibrary?: FlopLibrary | null;
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

type ResolvedOptions = Required<Omit<AnalyzeOptions, "charts" | "only" | "flopLibrary">> & {
  charts: ChartSet | null;
  only: number | null;
  flopLibrary: FlopLibrary | null;
};

/** `AnalyzeOptions.turn`, defaulted. */
const solvesTurn = (options: AnalyzeOptions) => options.turn ?? true;
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
  multi: MultiWalk | null = null,
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

  if (options.equity) {
    const seed = options.seed + spot.decision.order;
    // The nut checks are against any two cards, so they are certainties rather
    // than estimates — however many opponents there are (A9). Cheap on the
    // river (~1,000 combos) and the turn (x44); on the flop only a hand that
    // could plausibly be unbeatable is checked.
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
    // Multiway (A9) the equity is against the field, in `multiwayFacts`.
    const villain = multiway ? null : villainOf(spot, context);
    const wantEquity = villain !== null && toCall > 0 && (postflop || opponentAllIn || callAllIn);
    if (wantEquity && villain !== null) {
      const line = preflopLine(context, villain);
      const villainPosition = context.position.get(villain) ?? null;
      // Postflop in a heads-up pot: the villain's range narrowed by the
      // betting so far (A4). Otherwise the charts' range for the villain's
      // line where a node exists, the labelled placeholder where it does not.
      // A pot that was multiway earlier (A9): the villain's range from the multiway walk.
      const narrowed =
        postflop && walk && walk.villain === villain
          ? walk.before(spot.action.index)?.villain
          : postflop && multi
            ? (multi.before(spot.action.index)?.get(villain) ?? null)
            : null;
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
  model: NarrowingModel = heuristicModel,
  multi: MultiWalk | { ok: false; reason: WalkFailure } | null = null,
): RangeWalk | { ok: false; reason: WalkFailure } {
  const seats = flopSeats(context);
  // A9: three or more saw the flop. The heads-up part of the hand, if a
  // later street began heads-up, from the multiway walk.
  if (seats.length > 2 && seats.includes(hero) && multi) {
    if (!multi.ok) return multi.reason === "multiway-flop" ? multi : { ok: false, reason: multi.reason };
    return headsUpWalk(multi) ?? { ok: false, reason: "multiway-flop" };
  }
  if (seats.length !== 2 || !seats.includes(hero)) return { ok: false, reason: seats.length === 0 ? "no-flop" : "multiway-flop" };
  try {
    return walkRanges(hand, context, hero, seats[0] === hero ? seats[1] : seats[0], charts, model);
  } catch {
    return { ok: false, reason: "range-empty" };
  }
}

/** The multiway walk (A9) of a hand three or more players saw the flop of, or null. Never throws. */
function multiWalkOf(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  charts: ChartSet | null,
  model: NarrowingModel = heuristicModel,
): MultiWalk | { ok: false; reason: WalkFailure } | null {
  const seats = flopSeats(context);
  if (seats.length <= 2 || !seats.includes(hero)) return null;
  try {
    return walkMultiway(hand, context, hero, charts, model);
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

const TURN_WALK_REASONS: Record<WalkFailure, TurnSkipReason> = {
  "multiway-flop": "turn-multiway-flop",
  "range-unknown": "turn-range-unknown",
  "range-empty": "turn-range-empty",
  "no-flop": "turn-range-empty",
};

export interface HandTurn {
  /** Grades one hero turn decision, or says why not (sensitivity check included). */
  grade(spot: Spot): TurnGrade | TurnFailure;
  /** The solve and node a decision was graded at, for the study view. */
  line(spot: Spot): { solve: TurnSolve; node: number } | TurnFailure;
  /**
   * Both ranges as the river card came, from the solved turn (the full
   * narrowing's solve), or null when the turn was not solved, the line left
   * its tree by more than the off-tree distance, or a range hardly reaches
   * the river (`turn-unreached`).
   */
  riverStart(): PlayerRanges | null;
}

/**
 * The hand's turn, solved at most once per narrowing (A5a), exactly like the
 * river: read at each hero turn decision, with the sensitivity check for
 * grades of Inaccurate or worse. `turnSpot` is any hero turn decision: the
 * street's pot and effective stack are the same for all of them.
 */
function handTurn(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  turnSpot: Spot | null,
  walked: Walked,
  softWalk: () => Walked,
  charts: ChartSet | null,
  effectiveBb: number,
  potType: string,
): HandTurn {
  const solves = new Map<string, TurnSolve | TurnFailure>();
  const acts = streetActs(hand, "turn");
  let riverRanges: PlayerRanges | null | undefined;

  const run = (walk: Walked): TurnSolve | TurnFailure => {
    if (!turnSpot) return { ok: false, reason: "turn-range-empty", detail: "no hero turn decision" };
    if (!walk) return { ok: false, reason: "turn-range-empty", detail: "no postflop walk" };
    if (!walk.ok) return { ok: false, reason: TURN_WALK_REASONS[walk.reason], detail: walk.reason };
    if (!walk.turnStart && walk.multiway) return { ok: false, reason: "turn-multiway-flop", detail: "the turn began multiway" };
    if (!walk.turnStart) return { ok: false, reason: "turn-range-empty", detail: "no turn in the walk" };
    const bb = Math.max(1, hand.game.bigBlind);
    const cards = toIndices(context.players.get(hero)?.holeCards ?? []);
    const board = toIndices(turnSpot.board);
    if (cards.length !== 2 || board.length !== 4) return { ok: false, reason: "turn-solve-failed", detail: "cards" };
    const heroFirst = turnSpot.inPosition === false;
    const heroPos = String(context.position.get(hero) ?? "?");
    const villainPos = String(context.position.get(walk.villain) ?? "?");
    return solveTurnSpot({
      hand,
      heroSeat: hero,
      villainSeat: walk.villain,
      heroFirst,
      heroCards: [cards[0], cards[1]],
      board,
      potBb: turnSpot.streetPot / bb,
      stackBb: turnSpot.streetEffBehind / bb,
      ranges: walk.turnStart,
      charts,
      model: walk.model,
      acts,
      key: {
        players: hand.table.maxSeats,
        stackBucket: `${stackBucket(effectiveBb)}bb`,
        preflopLine: potType,
        positions: heroFirst ? [heroPos, villainPos] : [villainPos, heroPos],
      },
    });
  };

  const solved = (which: "full" | "half"): TurnSolve | TurnFailure => {
    let solve = solves.get(which);
    if (!solve) {
      solve = run(which === "full" ? walked : softWalk());
      solves.set(which, solve);
    }
    return solve;
  };

  const gradeOn = (spot: Spot, which: "full" | "half"): { graded: TurnGrade; solve: TurnSolve; node: number } | TurnFailure => {
    const solve = solved(which);
    if (!solve.ok) return solve;
    const at = acts.findIndex((act) => act.index === spot.action.index);
    if (at < 0) return { ok: false, reason: "turn-off-tree", detail: "the decision is not on the turn" };
    const found = followTurnLine(solve, acts.slice(0, at));
    if (!found.ok) return found;
    const graded = gradeTurn(solve, found, acts[at]);
    return graded.ok ? { graded, solve, node: found.node } : graded;
  };

  const decide = (spot: Spot): { graded: TurnGrade; solve: TurnSolve; node: number } | TurnFailure => {
    const full = gradeOn(spot, "full");
    if (!("graded" in full)) return full;
    const plain = { ...full, graded: { ...full.graded, turn: { ...full.graded.turn, sensitivity: null } } };
    if (gradeRank(full.graded.grade) < SENSITIVE_FROM) return plain;
    const half = gradeOn(spot, "half");
    if (!("graded" in half)) return plain;
    if (gradeRank(full.graded.grade) - gradeRank(half.graded.grade) > 1) {
      const approximations = [...new Set([...half.graded.approximations, "range-sensitive" as const])].sort();
      return {
        ...half,
        graded: {
          ...half.graded,
          approximations,
          turn: { ...half.graded.turn, sensitivity: { model: full.graded.turn.model, grade: full.graded.grade } },
        },
      };
    }
    return {
      ...full,
      graded: { ...full.graded, turn: { ...full.graded.turn, sensitivity: { model: half.graded.turn.model, grade: half.graded.grade } } },
    };
  };

  const riverStart = (): PlayerRanges | null => {
    if (riverRanges !== undefined) return riverRanges;
    riverRanges = null;
    const river = hand.board.runouts[0]?.river;
    const solve = solved("full");
    if (!river || !solve.ok) return riverRanges;
    const card = toSafeIndices([river]);
    if (!card) return riverRanges;
    const found = riverStartFromTurn(solve, acts, card[0]);
    if (found.ok && found.distance <= OFF_TREE_DISTANCE) riverRanges = found.ranges;
    return riverRanges;
  };

  return {
    grade: (spot) => {
      const decided = decide(spot);
      return "graded" in decided ? decided.graded : decided;
    },
    line: (spot) => {
      const decided = decide(spot);
      return "graded" in decided ? { solve: decided.solve, node: decided.node } : decided;
    },
    riverStart,
  };
}

export interface HandRiver {
  /** Grades one hero river decision, or says why not (sensitivity check included). */
  grade(spot: Spot): RiverGrade | RiverFailure;
  /** The solve and node a decision was graded at, for the study view. */
  line(spot: Spot): { solve: RiverSolve; node: number } | RiverFailure;
}

type Walked = RangeWalk | { ok: false; reason: WalkFailure } | null;

/**
 * The approximate river call (A9), with the sensitivity check of the solver
 * grades: a grade of Inaccurate or worse is recomputed on the half-strength
 * narrowing, and when the two are more than a class apart the milder one is
 * kept (`range-sensitive`).
 */
function approxRiver(
  spot: Spot,
  built: BuiltFacts,
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  multi: MultiWalk,
  softMulti: () => MultiWalked,
  charts: ChartSet | null,
  seed: number,
): ApproxGrade | RiverCallFailure {
  const action = spot.decision.type as "fold" | "call";
  const dominated = action === "fold" ? built.cannotLose : built.beatsNoHolding;
  const potBb = built.facts.potBb;
  const on = (walk: MultiWalk, model: NarrowingModel) => {
    const evs = riverCallEv({ spot, facts: built.facts, hand, context, hero, walk, model, charts, seed });
    return evs.ok ? gradeRiverCall(evs, action, potBb, dominated) : evs;
  };
  const full = on(multi, heuristicModel);
  if (!full.ok || gradeRank(full.grade) < SENSITIVE_FROM) return full;
  const softWalk = softMulti();
  if (!softWalk || !softWalk.ok) return full;
  const half = on(softWalk, halved(heuristicModel));
  if (!half.ok) return full;
  if (gradeRank(full.grade) - gradeRank(half.grade) > 1) {
    return {
      ...half,
      approximations: [...new Set([...half.approximations, "range-sensitive" as const])].sort(),
      ev: { ...half.ev, sensitivity: { model: multi.model, grade: full.grade } },
    };
  }
  return { ...full, ev: { ...full.ev, sensitivity: { model: softWalk.model, grade: half.grade } } };
}

/** Grades at or worse than this run the sensitivity check (§3.5, §9). */
const SENSITIVE_FROM = gradeRank("inaccurate");

/**
 * The hand's river, solved at most once per narrowing and read at each hero
 * river decision: a hand with a check and then a call is one solve read twice.
 *
 * **The sensitivity check.** A grade of Inaccurate or worse is re-graded on a
 * second solve whose ranges were narrowed at half strength (`halved`). When
 * the two grades are more than one class apart, the grade rests on the
 * narrowing rather than on the hand: the milder of the two is kept — its
 * options, its EVs, its solve (so the study view draws the same one) — and
 * marked `range-sensitive`. Only the bad grades pay for a second solve.
 */
function handRiver(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  walked: Walked,
  softWalk: () => Walked,
  charts: ChartSet | null,
  effectiveBb: number,
  potType: string,
  fromTurn: () => PlayerRanges | null = () => null,
): HandRiver {
  const solves = new Map<string, RiverSolve | RiverFailure>();
  const acts = riverActs(hand);

  const run = (spot: Spot, walk: Walked, which: "full" | "half"): RiverSolve | RiverFailure => {
    if (!walk) return { ok: false, reason: "river-range-empty", detail: "no postflop walk" };
    if (!walk.ok) return { ok: false, reason: WALK_REASONS[walk.reason], detail: walk.reason };
    if (!walk.riverStart && walk.multiway) return { ok: false, reason: "river-multiway-flop", detail: "the river began multiway" };
    if (!walk.riverStart) return { ok: false, reason: "river-range-empty", detail: "no river in the walk" };
    const bb = Math.max(1, hand.game.bigBlind);
    const cards = toIndices(context.players.get(hero)?.holeCards ?? []);
    const board = toIndices(spot.board);
    if (cards.length !== 2 || board.length !== 5) return { ok: false, reason: "river-solve-failed", detail: "cards" };
    const heroFirst = spot.inPosition === false;
    const heroPos = String(context.position.get(hero) ?? "?");
    const villainPos = String(context.position.get(walk.villain) ?? "?");
    // A5a: the full narrowing's river starts from the solved turn where there is one.
    const solvedTurn = which === "full" ? fromTurn() : null;
    return solveRiverSpot({
      hand,
      heroSeat: hero,
      villainSeat: walk.villain,
      heroFirst,
      heroCards: [cards[0], cards[1]],
      board,
      potBb: spot.streetPot / bb,
      stackBb: spot.streetEffBehind / bb,
      ranges: solvedTurn ?? walk.riverStart,
      narrowing: solvedTurn ? "turn-solver" : "heuristic",
      charts,
      model: walk.model,
      key: {
        players: hand.table.maxSeats,
        stackBucket: `${stackBucket(effectiveBb)}bb`,
        preflopLine: potType,
        positions: heroFirst ? [heroPos, villainPos] : [villainPos, heroPos],
      },
    });
  };

  const solved = (spot: Spot, which: "full" | "half"): RiverSolve | RiverFailure => {
    let solve = solves.get(which);
    if (!solve) {
      solve = run(spot, which === "full" ? walked : softWalk(), which);
      solves.set(which, solve);
    }
    return solve;
  };

  const gradeOn = (
    spot: Spot,
    which: "full" | "half",
  ): { graded: RiverGrade; solve: RiverSolve; node: number } | RiverFailure => {
    const solve = solved(spot, which);
    if (!solve.ok) return solve;
    const at = acts.findIndex((act) => act.index === spot.action.index);
    if (at < 0) return { ok: false, reason: "river-off-tree", detail: "the decision is not on the river" };
    const found = followLine(solve, acts.slice(0, at));
    if (!found.ok) return found;
    const graded = gradeRiver(solve, found, acts[at]);
    return graded.ok ? { graded, solve, node: found.node } : graded;
  };

  const decide = (spot: Spot): { graded: RiverGrade; solve: RiverSolve; node: number } | RiverFailure => {
    const full = gradeOn(spot, "full");
    if (!("graded" in full)) return full;
    if (gradeRank(full.graded.grade) < SENSITIVE_FROM) {
      return { ...full, graded: { ...full.graded, river: { ...full.graded.river, sensitivity: null } } };
    }
    const half = gradeOn(spot, "half");
    if (!("graded" in half)) {
      return { ...full, graded: { ...full.graded, river: { ...full.graded.river, sensitivity: null } } };
    }
    if (gradeRank(full.graded.grade) - gradeRank(half.graded.grade) > 1) {
      const approximations = [...new Set([...half.graded.approximations, "range-sensitive" as const])].sort();
      return {
        ...half,
        graded: {
          ...half.graded,
          approximations,
          river: { ...half.graded.river, sensitivity: { model: full.graded.river.model, grade: full.graded.grade } },
        },
      };
    }
    return {
      ...full,
      graded: {
        ...full.graded,
        river: { ...full.graded.river, sensitivity: { model: half.graded.river.model, grade: half.graded.grade } },
      },
    };
  };

  const grade = (spot: Spot): RiverGrade | RiverFailure => {
    const decided = decide(spot);
    return "graded" in decided ? decided.graded : decided;
  };

  const line = (spot: Spot): { solve: RiverSolve; node: number } | RiverFailure => {
    const decided = decide(spot);
    return "graded" in decided ? { solve: decided.solve, node: decided.node } : decided;
  };

  return { grade, line };
}

/**
 * The Mistake cap (`range-cap`, §3.5, §9): a river grade rests on ranges a
 * heuristic narrowed, which can carry "this costs a lot" but not "Blunder"
 * — unless the move loses whatever the opponent holds. Folding a hand that
 * cannot lose, or calling with one that beats nothing the opponent could
 * hold after their preflop line, is dominated on any narrowing and keeps its
 * Blunder.
 */
function capRiver(
  solved: RiverGrade,
  action: DecisionAnalysis["action"],
  built: BuiltFacts,
  walk: RangeWalk | null,
): RiverGrade {
  const capped = { ...solved, river: { ...solved.river, capped: null as RiverGrade["grade"] | null } };
  if (gradeRank(solved.grade) <= gradeRank("mistake")) return capped;
  let dominated = false;
  if (action === "fold") dominated = built.cannotLose;
  if (action === "call") {
    dominated = built.beatsNoHolding;
    if (!dominated && walk) {
      const facts = built.facts;
      const combos = weightedCombos(walk.preflop.villain);
      const versus = equityVsRange({ hero: facts.holeCards, range: combos, board: facts.board, method: "exhaustive" });
      dominated = versus.combos > 0 && versus.win + versus.tie <= 1e-12;
    }
  }
  if (dominated) return capped;
  return {
    ...capped,
    grade: "mistake",
    approximations: [...new Set([...solved.approximations, "range-cap" as const])].sort(),
    river: { ...capped.river, capped: solved.grade },
  };
}

/**
 * The Mistake cap on a turn grade (`range-cap`), as on the river: the turn's
 * ranges were narrowed on the flop by the heuristic. Dominated on any
 * narrowing, and so kept as a Blunder: folding a hand that cannot lose
 * whatever comes, or calling with one that has no equity at all against the
 * opponent's preflop range (it cannot even improve).
 */
function capTurn(
  solved: TurnGrade,
  action: DecisionAnalysis["action"],
  built: BuiltFacts,
  walk: RangeWalk | null,
): TurnGrade {
  const capped = { ...solved, turn: { ...solved.turn, capped: null as TurnGrade["grade"] | null } };
  if (gradeRank(solved.grade) <= gradeRank("mistake")) return capped;
  let dominated = false;
  if (action === "fold") dominated = built.cannotLose;
  if (action === "call" && walk) {
    const facts = built.facts;
    const combos = weightedCombos(walk.preflop.villain);
    const versus = equityVsRange({ hero: facts.holeCards, range: combos, board: facts.board, method: "exhaustive" });
    dominated = versus.combos > 0 && versus.win + versus.tie <= 1e-12;
  }
  if (dominated) return capped;
  return {
    ...capped,
    grade: "mistake",
    approximations: [...new Set([...solved.approximations, "range-cap" as const])].sort(),
    turn: { ...capped.turn, capped: solved.grade },
  };
}

/**
 * The Mistake cap on a flop grade from the library (`range-cap`): the
 * library's tree is coarse below the flop and a mapped flop is read by
 * category, which can carry "this costs a lot" but not "Blunder" - unless
 * the move loses whatever comes: folding a hand that cannot lose, calling
 * with no equity at all against the opponent's preflop range.
 */
function capFlop(solved: FlopGrade, action: DecisionAnalysis["action"], built: BuiltFacts, walk: RangeWalk | null): FlopGrade {
  const capped = { ...solved, flop: { ...solved.flop, capped: null as FlopGrade["grade"] | null } };
  if (gradeRank(solved.grade) <= gradeRank("mistake")) return capped;
  let dominated = false;
  if (action === "fold") dominated = built.cannotLose;
  if (action === "call" && walk) {
    const facts = built.facts;
    const combos = weightedCombos(walk.preflop.villain);
    const versus = equityVsRange({ hero: facts.holeCards, range: combos, board: facts.board, method: "exhaustive" });
    dominated = versus.combos > 0 && versus.win + versus.tie <= 1e-12;
  }
  if (dominated) return capped;
  return {
    ...capped,
    grade: "mistake",
    approximations: [...new Set([...solved.approximations, "range-cap" as const])].sort(),
    flop: { ...capped.flop, capped: solved.grade },
  };
}

/**
 * A later street's approximations when the flop's ranges came from the
 * library: the flop was not narrowed by the heuristic, so its code gives
 * way to the library's own (mapped, bucketed) - unless the turn too was
 * narrowed by the heuristic (a river after an unsolved turn).
 */
function libraryApprox(list: readonly Approximation[], flop: HandFlop, heuristicTurn: boolean): Approximation[] {
  if (!flop.entry || flop.model?.flopSource() !== "library" || heuristicTurn) return [...list];
  const out = new Set(list);
  out.delete("narrowing-heuristic");
  if (!flop.entry.exact) {
    out.add("flop-mapped");
    out.add("library-bucketed");
  }
  return [...out].sort();
}

/**
 * Whether an equity fact's range was narrowed by solved strategies all the
 * way (A5b): the flop by the library, and - on a later street - by the
 * solve the fact itself comes from (the turn's, or the river's when its
 * ranges came through the solved turn).
 */
function solverNarrowed(
  street: DecisionStreet,
  source: string | undefined,
  flop: HandFlop,
  river: RiverGrade | RiverFailure | null,
): boolean {
  if (flop.model?.flopSource() !== "library") return false;
  if (street === "flop") return true;
  if (source !== "solver") return false;
  return street === "turn" || (street === "river" && river?.ok === true && river.river.narrowing === "turn-solver");
}

/** The equity fact of a solved turn decision: against the opponent's range at the node, over every river. */
function turnEquity(solved: TurnGrade, facts: SpotFacts, walk: RangeWalk | null): SpotFacts["equity"] {
  const previous = facts.equity;
  if (!previous) return null;
  return {
    value: solved.turn.equity,
    range: walk?.labels.villain ?? previous.range,
    source: "solver",
    combos: solved.turn.villainCombos,
    method: "exhaustive",
    strong: null,
  };
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
  const { river } = handSolvers(hand, context, hero, heroSpots(context, hero), options.charts ?? null, solvesTurn(options), options.flopLibrary ?? null);
  const found = river.line(spot);
  if (!("solve" in found)) return found;
  return riverStudyAt(found.solve, found.node);
}

/**
 * The study view of one hero turn decision (A5a): the hero's whole range at
 * the node as the turn solve plays it. The same walk and solve `analyzeHand`
 * runs. Null when the action is not a hero turn decision of a hand the
 * analysis covers; a `TurnFailure` when the solver cannot take it.
 */
export function turnStudy(
  hand: PhfHand,
  actionIndex: number,
  options: AnalyzeOptions = {},
): RiverStudy | TurnFailure | null {
  const context = buildContext(hand);
  const hero = heroSeatOf(context);
  if (hero === null || handSkip(hand, context, hero) !== null) return null;
  const spots = heroSpots(context, hero);
  const spot = spots.find((s) => s.action.index === actionIndex);
  if (!spot || spot.street !== "turn" || spot.opponents.length !== 1) return null;
  const { turn } = handSolvers(hand, context, hero, spots, options.charts ?? null, true, options.flopLibrary ?? null);
  const found = turn.line(spot);
  if (!("solve" in found)) return found;
  return turnStudyAt(found.solve, found.node);
}

/**
 * The turn and river of a hand, wired the way `analyzeHand` wires them: the
 * river's full narrowing comes from the solved turn when there is one.
 */
/** The hand's flop library entry and the narrowing model built on it, when it reads the library. */
interface HandFlop {
  entry: FlopEntry | null;
  model: LibraryModel | null;
}

function handSolvers(
  hand: PhfHand,
  context: StatsContext,
  hero: number,
  spots: readonly Spot[],
  charts: ChartSet | null,
  solveTurns: boolean,
  flopLibrary: FlopLibrary | null = null,
): { walked: Walked; multi: MultiWalked; softMulti: () => MultiWalked; turn: HandTurn; river: HandRiver; flop: HandFlop } {
  const postflop = spots.some((spot) => spot.street !== "preflop");
  // A5b: the flop library, where the hand's line and flop have a chunk.
  const found = postflop && flopLibrary ? libraryEntry(hand, context, hero, charts, flopLibrary) : null;
  const entry = found && found.ok ? found : null;
  const model = entry ? libraryModel(entry, heuristicModel) : null;
  // A9: three or more saw the flop - every range walked, the heads-up part handed on.
  const multi = postflop ? multiWalkOf(hand, context, hero, charts) : null;
  const walked = postflop ? rangeWalkOf(hand, context, hero, charts, model ?? heuristicModel, multi) : null;
  let softMultiWalk: MultiWalked | undefined;
  const softMulti = () => {
    softMultiWalk ??= multi ? multiWalkOf(hand, context, hero, charts, halved(heuristicModel)) : null;
    return softMultiWalk;
  };
  let soft: Walked | undefined;
  const softWalk = () => {
    soft ??= rangeWalkOf(hand, context, hero, charts, halved(heuristicModel), softMulti());
    return soft;
  };
  const effectiveBb = effectiveStackBb(context, hero);
  const potType = potTypeOf(context);
  const turnSpot = spots.find((spot) => spot.street === "turn" && spot.opponents.length === 1) ?? null;
  const turn = handTurn(hand, context, hero, turnSpot, walked, softWalk, charts, effectiveBb, potType);
  const river = handRiver(hand, context, hero, walked, softWalk, charts, effectiveBb, potType, () =>
    solveTurns ? turn.riverStart() : null,
  );
  return { walked, multi, softMulti, turn, river, flop: { entry, model } };
}

type MultiWalked = MultiWalk | { ok: false; reason: WalkFailure } | null;

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
    only: options.only ?? null,
    turn: solvesTurn(options),
    flopLibrary: options.flopLibrary ?? null,
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

  // The range walk (A4) through a heads-up hand, once; the turn and river solves (A5a, A4) on it.
  const { walked, multi: multiWalked, softMulti, turn, river, flop } = handSolvers(
    hand,
    context,
    hero,
    spots,
    resolved.charts,
    resolved.turn,
    resolved.flopLibrary,
  );
  const walk = walked && walked.ok ? walked : null;
  const multi = multiWalked && multiWalked.ok ? multiWalked : null;

  let preflopSeen = 0;
  const decisions: DecisionAnalysis[] = spots.flatMap((spot) => {
    const street = spot.street as DecisionStreet;
    const multiway = street !== "preflop" && spot.opponents.length >= 2;
    const preflopNth = street === "preflop" ? preflopSeen++ : -1;
    if (resolved.only !== null && spot.action.index !== resolved.only) return [];
    let built: BuiltFacts;
    try {
      built = buildFacts(spot, context, hero, multiway, resolved, walk, multi);
    } catch {
      // An equity request the engine refuses (a card dealt twice by a broken
      // export) must not cost the decision its other facts.
      built = buildFacts(spot, context, hero, multiway, { ...resolved, equity: false }, walk, multi);
    }
    const { facts } = built;
    const approximations = new Set<Approximation>(handApprox);

    // Turn and river: the solver, or the reason it cannot answer.
    const action = spot.decision.type as DecisionAnalysis["action"];
    const rawRiver = street === "river" && !multiway ? river.grade(spot) : null;
    const rawTurn = street === "turn" && !multiway && resolved.turn ? turn.grade(spot) : null;
    const solvedRiver = rawRiver?.ok ? capRiver(rawRiver, action, built, walk) : rawRiver;
    const solvedTurn = rawTurn?.ok ? capTurn(rawTurn, action, built, walk) : rawTurn;
    // A5b: a flop decision the library can follow is graded from it; one it cannot keeps the heuristic.
    const heroCards = toSafeIndices(built.facts.holeCards);
    const rawFlop =
      street === "flop" && !multiway && flop.entry && heroCards?.length === 2
        ? gradeFlop(flop.entry, spot.action.index, [heroCards[0], heroCards[1]])
        : null;
    const solvedFlop = rawFlop?.ok ? capFlop(rawFlop, action, built, walk) : null;
    if (solvedFlop) {
      facts.flop = solvedFlop.flop;
    }
    if (solvedTurn?.ok) {
      solvedTurn.approximations = libraryApprox(solvedTurn.approximations, flop, false);
    }
    if (solvedRiver?.ok) {
      solvedRiver.approximations = libraryApprox(solvedRiver.approximations, flop, solvedRiver.river.narrowing !== "turn-solver");
    }

    // Multiway (A9): facts against every range and the field, and for a river
    // call or fold facing a bet in a pot that was multiway, the approximate EV.
    const wasMultiway = multiway || (street === "river" && solvedRiver !== null && !solvedRiver.ok && solvedRiver.reason === "river-multiway-flop");
    let mw: MultiwayFacts | null = null;
    let approx: ApproxGrade | null = null;
    let approxSkip: MultiwaySkipReason | null = null;
    if (wasMultiway) {
      try {
        mw = multiwayFacts({
          spot,
          facts,
          hand,
          context,
          hero,
          walk: multi,
          model: heuristicModel,
          seed: resolved.seed + spot.decision.order,
          equity: resolved.equity,
        });
      } catch {
        mw = null;
      }
      if (street === "river" && spot.toCall > 0 && (action === "fold" || action === "call")) {
        if (!multi) {
          approxSkip = "multiway-range-unknown";
        } else {
          try {
            const result = approxRiver(spot, built, hand, context, hero, multi, softMulti, resolved.charts, resolved.seed + spot.decision.order);
            if (result.ok) approx = result;
            else approxSkip = result.reason;
          } catch {
            approxSkip = "multiway-range-unknown";
          }
        }
      }
      if (mw) {
        if (approx) mw.ev = approx.ev;
        facts.multiway = mw;
        if (multiway) {
          facts.scenario = `${facts.role}-mw-${mw.lastToAct ? "ip" : "oop"}-${facts.facing}`;
          if (mw.field !== null) {
            facts.equity = {
              value: mw.field,
              range: `field:${mw.players - 1}`,
              source: "narrowed",
              combos: Math.round(mw.opponents.reduce((sum, o) => sum + o.combos, 0)),
              method: mw.fieldMethod ?? "monte-carlo",
              strong: null,
            };
          }
        }
      }
    }

    if (solvedRiver?.ok) {
      facts.river = solvedRiver.river;
      if (facts.equity) {
        facts.equity = riverEquity(solvedRiver, facts, walk);
      }
    }
    if (solvedTurn?.ok) {
      facts.turn = solvedTurn.turn;
      if (facts.equity) {
        facts.equity = turnEquity(solvedTurn, facts, walk);
      }
    }
    const solved = approx ? null : (solvedRiver ?? solvedTurn ?? solvedFlop);
    if (facts.equity) {
      const source = facts.equity.source;
      if (source === "chart") approximations.add("preflop-range");
      else if (source === "placeholder") approximations.add("placeholder-range");
      // Ranges narrowed by the library on the flop, and by solves after it, are not the heuristic's.
      else if (!solverNarrowed(street, source, flop, solvedRiver)) approximations.add("narrowing-heuristic");
    }
    if (walk && walk.sources.villain === "placeholder" && (solved?.ok || facts.equity?.source === "narrowed")) {
      approximations.add("placeholder-range");
    }
    if (solved?.ok && walk && walk.sources.hero === "placeholder") approximations.add("placeholder-range");
    // A heads-up solve of a pot that was multiway earlier (A9).
    if (solved?.ok && walk?.multiway) approximations.add("multiway-history");
    if (mw && mw.opponents.some((o) => o.source === "placeholder")) approximations.add("placeholder-range");

    // Preflop: the charts, or the reason they cannot answer.
    const chart =
      street === "preflop"
        ? gradePreflop(
            { hand, heroSeat: hero, nth: preflopNth, actionIndex: spot.action.index, potBb: facts.potBb },
            resolved.charts,
          )
        : null;
    const skipped = approx
      ? null
      : approxSkip
        ? approxSkip
        : multiway
          ? "multiway"
          : chart && !chart.ok
            ? chart.reason
            : solved && !solved.ok
              ? solved.reason
              : null;
    if (approx) {
      for (const value of approx.approximations) approximations.add(value);
    } else if (solved?.ok) {
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
    // decision (A9) keeps them too — its equity is against the field — and
    // adds the multiway ones.
    const flags = heuristicFlags({
      spot,
      facts,
      cannotLose: built.cannotLose,
      beatsNoHolding: built.beatsNoHolding,
      noMoreCards: built.noMoreCards,
      startingStack: heroStack,
      bigBlind: bb,
    });
    if (multiway && mw) flags.push(...multiwayFlags(spot, facts, mw));
    flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "inaccurate" ? -1 : 1));

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
      options: chart?.ok ? chart.options : solved?.ok ? solved.options : approx ? approx.options : [],
      chosen: chart?.ok ? chart.chosen : solved?.ok ? solved.chosen : approx ? approx.chosen : null,
      evLoss: chart?.ok ? chart.evLoss : solved?.ok ? solved.evLoss : approx ? round3(approx.evLoss) : null,
      evLossPot: chart?.ok ? chart.evLossPot : solved?.ok ? solved.evLossPot : approx ? round4(approx.evLossPot) : null,
      freqDiff: chart?.ok ? chart.freqDiff : solved?.ok ? solved.freqDiff : approx ? round4(approx.freqDiff) : null,
      grade: chart?.ok ? chart.grade : solved?.ok ? solved.grade : approx ? approx.grade : null,
      score: chart?.ok ? chart.score : solved?.ok ? solved.score : approx ? round2(approx.score) : null,
      source: chart?.ok ? "chart" : solved?.ok ? "solver" : approx ? "approx" : "heuristic",
      approximations: [...approximations].sort(),
      facts,
      flags,
      worstFlag: worstSeverity(flags.map((flag) => flag.severity)),
    };
  });

  if (decisions.length === 0) {
    return emptyAnalysis("no-decisions", hero, potType);
  }
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
