/**
 * Turn grading with our solver (phase A5a, `docs/ANALYSIS-PLAN.md` §3.2–§3.5).
 *
 * ```
 * rangeWalk (turn start) ─▶ solveTurn (lib/solver: isomorphism, coarse river) ─▶ the real turn line onto the tree
 *                                                                              └▶ the hero's combo: strategy + EV per action
 *                                                                                 ─▶ options, grade() (§2), source "solver"
 *                        └▶ the solved turn strategy, followed to the river deal ─▶ the river's ranges (`river.ts`)
 * ```
 *
 * **The subgame.** Both ranges as the turn card came (narrowed on the flop by
 * the heuristic model), the pot and effective stack at the start of the
 * turn, the out-of-position player first, the charts' rake profile, and a
 * tree chosen by measurement (§10, A5a):
 *
 * - turn: bets of 75% of the pot and all-in, raises of 75% (of the pot after
 *   the call) and all-in, one raise; the all-in only while it is at most
 *   `ALLIN_MAX_POT` pots (with 90 bb behind a 9-pot turn shove is a branch
 *   every iteration pays for and no strategy uses);
 * - plus the sizes the hand itself used on the turn (`lineMenu`): a real bet
 *   far from 75% is solved as played instead of being read as 75% and capped
 *   (44% of the library's turn bets were more than 25% of the pot from 75%);
 * - river below it: bets of 75% and all-in, always - no raise. Capping the
 *   river's all-in at three pots too solved twice as fast but cost the nuts
 *   their river shove, and a flat of the nuts on the turn came out a Blunder
 *   where the full river calls it Good; a river raise doubled the time again
 *   for little change in grades.
 *
 * The river cards are dealt one per suit-isomorphism class (the board and
 * both ranges are symmetric under a relabelling of the suits the board does
 * not use) - exact, not an approximation. Chance sampling exists in the
 * engine (`ChanceSampling`) but is off: on these trees each river subgame
 * needs its own few dozen updates whatever order they come in, so sampling
 * only moved the work around (measured in `tests/scripts/solver-bench`).
 *
 * **Solved once per hand** to `TURN_TARGET_PCT` (1% of the pot,
 * exploitability measured exactly over the whole turn + river tree) and read
 * at every hero turn decision. Deterministic: the same hand gives the same
 * bits, so the hand view's re-solve for the study grid equals the stored row.
 *
 * **What is stored** is the options for the hero's combo, the grade and a few
 * numbers (`TurnFacts`); never the strategy (§3.4).
 */

import type { ChartSet } from "../charts";
import { evaluateMasks, STANDARD } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import {
  comboHi,
  comboIndex,
  comboLo,
  NUM_COMBOS,
  OFF_TREE_DISTANCE,
  permuteCombo,
  rangesAt,
  solveTurn,
  spotHash,
  spotKey,
  spotSymmetries,
  symmetrize,
  type BetMenu,
  type SolveResult,
} from "../solver";
import type { GradeResult } from "./grading";
import { handStrength } from "./narrowing";
import type { PlayerRanges } from "./rangeWalk";
import {
  followSolvedLine,
  gradeMapped,
  mapAct,
  nodeRanges,
  optionsAt,
  PRUNE_SHARE,
  pruned,
  rakeOf,
  shapeOf,
  STRONG_HS,
  studyAt,
  toCombos,
  TRANSLATED_DISTANCE,
  WEAK_HS,
  withoutCards,
  type LineFailure,
  type LineOnTree,
  type RiverStudy,
  type StreetAct,
} from "./river";
import { draws, madeHand } from "./texture";
import type { Approximation, OptionAnalysis, TurnFacts, TurnRole, TurnSkipReason } from "./types";

/* ------------------------------------------------------------ constants - */

/** The turn's all-in is offered only up to this many pots (the river's always is). */
export const ALLIN_MAX_POT = 3;
/** The turn bet menu, the same for both players. */
export const TURN_MENU: Readonly<BetMenu> = { bet: [0.75], raise: [0.75], allIn: true, allInMaxPot: ALLIN_MAX_POT };
/** The coarse river below the turn (§3.2: one size + all-in), with no raise (`TURN_RIVER_RAISE_CAP`). */
export const TURN_RIVER_MENU: Readonly<BetMenu> = { bet: [0.75], raise: [], allIn: true };
/** The tree's profile id, part of the spot key. */
export const TURN_TREE = "turn-m1";
/** Raises after the first bet on the turn; none on the river below it. */
export const TURN_RAISE_CAP = 1;
export const TURN_RIVER_RAISE_CAP = 0;
/** A size leaving less than this × the pot after the call behind is all-in. */
export const TURN_ALLIN_THRESHOLD = 0.1;
/** Smallest bet, in big blinds. */
export const TURN_MIN_BET = 1;
/** Solve to this exploitability, % of the pot at the start of the turn (A5a's target). */
export const TURN_TARGET_PCT = 1;
/** …or stop here. */
export const TURN_MAX_ITERATIONS = 400;
/** First exploitability measurement, then every `TURN_CHECK_EVERY`: a measurement walks the whole tree three times. */
export const TURN_CHECK_FROM = 30;
export const TURN_CHECK_EVERY = 10;
/** DCFR with a steeper average weighting (`t^3`): measured 5–15% fewer iterations on turn trees. */
export const TURN_DCFR = { alpha: 1.5, beta: 0, gamma: 3 } as const;

/**
 * A turn tree and how far to solve it: the grading profile below, or another
 * one the benchmark compares it with (`tests/scripts/solver-bench`).
 */
export interface TurnProfile {
  /** Part of the spot key. */
  tree: string;
  menu: BetMenu;
  /**
   * Add the hand's own turn sizes to `menu` (`lineMenu`): a bet or raise the
   * hand made more than `LINE_SIZE_GAP` from every menu size becomes a size
   * of the tree, and a shove the menu leaves out (`allInMaxPot`) puts the
   * all-in back.
   */
  lineSizes?: boolean;
  riverMenu: BetMenu;
  raiseCap: number;
  riverRaiseCap: number;
  targetPct: number;
  maxIterations: number;
}

/** A real size within this many pots of a menu size is translated onto it rather than added (`lineMenu`). */
export const LINE_SIZE_GAP = 0.1;

/** What turn grading solves (A5a). */
export const TURN_PROFILE: Readonly<TurnProfile> = {
  tree: TURN_TREE,
  menu: TURN_MENU,
  lineSizes: true,
  riverMenu: TURN_RIVER_MENU,
  raiseCap: TURN_RAISE_CAP,
  riverRaiseCap: TURN_RIVER_RAISE_CAP,
  targetPct: TURN_TARGET_PCT,
  maxIterations: TURN_MAX_ITERATIONS,
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/* ------------------------------------------------------------ the solve - */

export interface TurnSpotInput {
  hand: PhfHand;
  heroSeat: number;
  villainSeat: number;
  /** The hero acts first on the turn (is out of position). */
  heroFirst: boolean;
  heroCards: readonly [number, number];
  /** The four turn cards. */
  board: readonly number[];
  /** Pot and effective stack at the start of the turn, bb. */
  potBb: number;
  stackBb: number;
  ranges: PlayerRanges;
  charts: ChartSet | null;
  /** The flop's narrowing model, e.g. `heuristic/2`. */
  model: string;
  key: { players: number; stackBucket: string; preflopLine: string; positions: readonly [string, string] };
  /** The turn's actions as played, for the line's own sizes (`TurnProfile.lineSizes`). */
  acts?: readonly StreetAct[];
}

/**
 * The turn menu for one hand: `base` plus the sizes the hand itself used on
 * the turn (A5a). A turn bet of 40% with a menu of 75% would be 35% of the
 * pot off the tree - a capped grade - for 44% of the turn bets in the
 * owner's library (§10); solving the size that was played instead costs one
 * branch, and only in the hands that need it. Sizes within `LINE_SIZE_GAP`
 * of a menu size are left to translation. Returns the menu and a suffix for
 * the tree's id (`+b0.4`, `+r1.2`, `+ai`).
 */
export function lineMenu(
  base: Readonly<BetMenu>,
  acts: readonly StreetAct[],
  stackBb: number,
): { menu: BetMenu; suffix: string } {
  const bet = [...base.bet];
  const raise = [...base.raise];
  let allInMaxPot = base.allInMaxPot;
  let suffix = "";
  for (const act of acts) {
    if (act.type !== "bet" && act.type !== "raise") continue;
    if (act.allIn || act.to >= stackBb - 1e-6) {
      if (allInMaxPot !== undefined) suffix += "+ai";
      allInMaxPot = undefined;
      continue;
    }
    const x = act.sizePot;
    if (x === null || !(x > 0)) continue;
    const list = act.type === "bet" ? bet : raise;
    const gap = list.length ? Math.min(...list.map((size) => Math.abs(size - x))) : Infinity;
    if (gap > LINE_SIZE_GAP) {
      const size = round2(x);
      list.push(size);
      suffix += `+${act.type === "bet" ? "b" : "r"}${size}`;
    }
  }
  bet.sort((a, b) => a - b);
  raise.sort((a, b) => a - b);
  return { menu: { bet, raise, allIn: base.allIn, allInMaxPot }, suffix };
}

export interface TurnSolve {
  ok: true;
  result: SolveResult;
  hero: 0 | 1;
  heroCombo: number;
  heroHand: number;
  outOfRange: boolean;
  rake: string;
  spot: string;
  /** The tree's id: the profile's, plus the line's own sizes (`lineMenu`). */
  tree: string;
  input: TurnSpotInput;
}

export type TurnFailure = { ok: false; reason: TurnSkipReason; detail: string };

/** Solves the turn of a heads-up hand, through a coarse river. */
export function solveTurnSpot(input: TurnSpotInput, profile: Readonly<TurnProfile> = TURN_PROFILE): TurnSolve | TurnFailure {
  if (!(input.potBb > 0) || !(input.stackBb > 0)) {
    return { ok: false, reason: "turn-off-tree", detail: "nothing behind to bet" };
  }
  const heroCombo = comboIndex(input.heroCards[0], input.heroCards[1]);
  // Symmetric first, then pruned: pruning a range that is symmetric up to
  // float noise could keep one combo of a pair and drop its twin, and cost
  // the solve its isomorphism.
  const group = spotSymmetries(input.board, [input.ranges.hero, input.ranges.villain]);
  const heroRange = pruned(symmetrize(input.ranges.hero, group));
  const villainRange = pruned(symmetrize(input.ranges.villain, group));
  const outOfRange = !(heroRange[heroCombo] > 0);
  if (outOfRange) {
    let max = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) max = Math.max(max, heroRange[c]);
    const floor = Math.max(max * PRUNE_SHARE, 1e-9);
    // The hero's combo and every combo isomorphic to it, so the spot keeps its symmetry.
    for (const perm of group) heroRange[permuteCombo(heroCombo, perm)] = floor;
  }
  const ranges: [Float64Array, Float64Array] = input.heroFirst ? [heroRange, villainRange] : [villainRange, heroRange];
  const rake = rakeOf(input.charts);
  const line = profile.lineSizes && input.acts ? lineMenu(profile.menu, input.acts, input.stackBb) : null;
  const menu = line?.menu ?? profile.menu;
  const tree = profile.tree + (line?.suffix ?? "");

  let result: SolveResult;
  try {
    result = solveTurn(
      {
        board: [...input.board],
        ranges,
        pot: input.potBb,
        stack: input.stackBb,
        firstToAct: 0,
        menus: [menu, menu],
        riverMenus: [profile.riverMenu, profile.riverMenu],
        raiseCap: profile.raiseCap,
        riverRaiseCap: profile.riverRaiseCap,
        allInThreshold: TURN_ALLIN_THRESHOLD,
        minBet: TURN_MIN_BET,
        rake: { percent: rake.percent, cap: rake.cap },
        bigBlind: 1,
        isomorphism: true,
      },
      {
        maxIterations: profile.maxIterations,
        targetExploitability: profile.targetPct,
        checkEvery: TURN_CHECK_EVERY,
        checkFrom: TURN_CHECK_FROM,
        dcfr: TURN_DCFR,
        nodes: "turn",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: /empty/.test(message) ? "turn-range-empty" : "turn-solve-failed", detail: message };
  }
  const hero: 0 | 1 = input.heroFirst ? 0 : 1;
  const heroHand = result.hands[hero].indexOf(heroCombo);
  if (heroHand < 0) return { ok: false, reason: "turn-solve-failed", detail: "the hero's combo is not in the solve" };

  let spot = "";
  try {
    spot = spotHash(
      spotKey({
        format: "nlhe-cash",
        players: input.key.players,
        stackBucket: input.key.stackBucket,
        preflopLine: input.key.preflopLine,
        positions: input.key.positions,
        board: [...input.board],
        line: "-",
        sprBucket: `spr${Math.round((input.stackBb / input.potBb) * 4) / 4}`,
        rake: rake.name.replace(/\s/g, ""),
        tree,
        ranges,
      }),
    );
  } catch {
    spot = "";
  }
  return { ok: true, result, hero, heroCombo, heroHand, outOfRange, rake: rake.name, spot, tree, input };
}

/** Follows the turn's actions before the hero's decision onto the solved tree. */
export function followTurnLine(solve: TurnSolve, acts: readonly StreetAct[]): LineOnTree | LineFailure<"turn"> {
  return followSolvedLine(solve, acts, "turn");
}

/**
 * Both ranges as the river card comes, read off the solved turn strategy
 * (A5a: the river's narrowing once the turn is solved). `acts` is the whole
 * turn; it must close with chips behind (a call or two checks), and both
 * ranges must reach that point. The river card's combos are removed.
 */
export function riverStartFromTurn(
  solve: TurnSolve,
  acts: readonly StreetAct[],
  riverCard: number,
): { ok: true; ranges: PlayerRanges; distance: number } | LineFailure<"turn"> {
  const line = followSolvedLine(solve, acts, "turn", { end: "street" });
  if (!line.ok) return line;
  const reach = rangesAt(solve.result, line.node);
  const villain = (1 - solve.hero) as 0 | 1;
  const hero = withoutCards(toCombos(solve.result, solve.hero, reach[solve.hero]), [riverCard]);
  const opponent = withoutCards(toCombos(solve.result, villain, reach[villain]), [riverCard]);
  return { ok: true, ranges: { hero, villain: opponent }, distance: line.distance };
}

/* ---------------------------------------------------------------- grade - */

export interface TurnGrade extends GradeResult {
  ok: true;
  options: OptionAnalysis[];
  chosen: number;
  approximations: Approximation[];
  turn: TurnFacts;
  /** The opponent's range at the node (1,326 weights, the hero's cards removed), for the equity fact. */
  villainRange: Float64Array;
}

/**
 * The hero's hand against `villain` (1,326 weights, compatible with the hero's
 * cards) over every river card: the equity, and the share of rivers after
 * which it beats at least `STRONG_HS` / under `WEAK_HS` of the range.
 */
export function riverOutlook(
  hole: readonly [number, number],
  board: readonly number[],
  villain: ArrayLike<number>,
): { equity: number; strong: number; weak: number; rivers: number } {
  const dead = new Set([...board, ...hole]);
  const masks = [0, 0, 0, 0];
  for (const card of board) masks[card & 3] |= 1 << (card >> 2);
  const live: number[] = [];
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (villain[c] > 0 && !dead.has(comboHi(c)) && !dead.has(comboLo(c))) live.push(c);
  }
  let sum = 0;
  let strong = 0;
  let weak = 0;
  let rivers = 0;
  for (let river = 0; river < 52; river += 1) {
    if (dead.has(river)) continue;
    const m = masks.slice();
    m[river & 3] |= 1 << (river >> 2);
    const mine = m.slice();
    for (const card of hole) mine[card & 3] |= 1 << (card >> 2);
    const heroValue = evaluateMasks(STANDARD, mine[0], mine[1], mine[2], mine[3]);
    let total = 0;
    let score = 0;
    for (const c of live) {
      const a = comboHi(c);
      const b = comboLo(c);
      if (a === river || b === river) continue;
      const v = m.slice();
      v[a & 3] |= 1 << (a >> 2);
      v[b & 3] |= 1 << (b >> 2);
      const value = evaluateMasks(STANDARD, v[0], v[1], v[2], v[3]);
      const w = villain[c];
      total += w;
      score += heroValue > value ? w : heroValue === value ? w / 2 : 0;
    }
    if (!(total > 0)) continue;
    const share = score / total;
    sum += share;
    rivers += 1;
    if (share >= STRONG_HS) strong += 1;
    else if (share < WEAK_HS) weak += 1;
  }
  return rivers > 0
    ? { equity: sum / rivers, strong: strong / rivers, weak: weak / rivers, rivers }
    : { equity: 0, strong: 0, weak: 0, rivers: 0 };
}

/** Rivers that must make the hand strong before a hand behind counts as a draw. */
const DRAW_RIVERS = 0.15;
/** Rivers that turn a hand ahead into a loser before it counts as vulnerable. */
const VULNERABLE_RIVERS = 0.2;

export function turnRole(heroBeats: number, outlook: { equity: number; strong: number; weak: number }, facingBet: boolean): TurnRole {
  if (outlook.equity >= 0.65 && heroBeats >= 0.6) return outlook.weak >= VULNERABLE_RIVERS ? "vulnerable" : "value";
  if (heroBeats < 0.5 && outlook.strong >= DRAW_RIVERS) return "draw";
  if (facingBet && outlook.equity >= 0.2) return "bluff-catcher";
  if (outlook.equity < 0.3) return "air";
  return "medium";
}

/** Grades the hero's turn decision at `line.node`. `act` is what the hero did. */
export function gradeTurn(solve: TurnSolve, line: LineOnTree, act: StreetAct): TurnGrade | TurnFailure {
  const { result } = solve;
  const node = result.nodes[line.node];
  const options = optionsAt(result, node, solve.heroHand);
  const mapped = mapAct(node, act, solve.input.stackBb);
  if (!mapped) return { ok: false, reason: "turn-off-tree", detail: `no ${act.type} for the hero at ${node.path}` };
  const distance = Math.max(line.distance, mapped.distance);
  const offTree = distance > OFF_TREE_DISTANCE;
  const best = gradeMapped(options, mapped, act.pot, offTree);
  if (!best) return { ok: false, reason: "turn-off-tree", detail: "nothing to grade against" };
  const { chosen, graded } = best;

  const ranges = nodeRanges(solve, line.node);
  const heroCards = [...solve.input.heroCards] as [number, number];
  const villainSeen = withoutCards(ranges.villain, heroCards);
  const heroHs = handStrength(ranges.strength, villainSeen);
  const beatsRaw = heroHs[solve.heroCombo];
  const heroBeats = Number.isNaN(beatsRaw) ? 0 : beatsRaw;
  const outlook = riverOutlook(heroCards, solve.input.board, villainSeen);
  const villainHs = handStrength(ranges.strength, ranges.hero);
  let strong = 0;
  let medium = 0;
  let weak = 0;
  let total = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = villainSeen[c];
    if (!(w > 0) || Number.isNaN(villainHs[c])) continue;
    total += w;
    if (villainHs[c] >= STRONG_HS) strong += w;
    else if (villainHs[c] < WEAK_HS) weak += w;
    else medium += w;
  }
  let heroCombos = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) heroCombos += ranges.hero[c];
  const share = (x: number) => (total > 0 ? round3(x / total) : 0);

  const approximations = new Set<Approximation>(["narrowing-heuristic", "rake-profile", "coarse-river"]);
  if (offTree) approximations.add("off-tree-size");
  else if (distance > TRANSLATED_DISTANCE) approximations.add("size-translated");
  if (result.exploitabilityPct > TURN_TARGET_PCT) approximations.add("solver-unconverged");
  if (solve.outOfRange) approximations.add("out-of-range");

  const turn: TurnFacts = {
    model: solve.input.model,
    tree: solve.tree,
    rake: solve.rake,
    path: node.path,
    iterations: result.iterations,
    exploitabilityPct: round3(result.exploitabilityPct),
    converged: result.exploitabilityPct <= TURN_TARGET_PCT,
    spot: solve.spot,
    riverClasses: result.isomorphism?.classes.length ?? 44,
    heroCombos: round2(heroCombos),
    villainCombos: round2(total),
    heroBeats: round3(heroBeats),
    equity: round3(outlook.equity),
    rivers: { strong: round3(outlook.strong), weak: round3(outlook.weak) },
    role: turnRole(heroBeats, outlook, node.toCall > 0),
    villain: { strong: share(strong), medium: share(medium), weak: share(weak), shape: shapeOf(share(strong), share(medium), share(weak)) },
    translated: distance > TRANSLATED_DISTANCE ? round3(distance) : null,
    reach: { hero: round3(line.reach.hero), villain: round3(line.reach.villain) },
  };

  return {
    ok: true,
    options,
    chosen,
    approximations: [...approximations].sort(),
    turn,
    villainRange: villainSeen,
    grade: graded.grade,
    evLoss: round3(graded.evLoss),
    evLossPot: Number.isFinite(graded.evLossPot) ? round4(graded.evLossPot) : 1,
    freqDiff: round4(graded.freqDiff),
    score: round2(graded.score),
  };
}

/* ---------------------------------------------------------------- study - */

/** Hand categories of the turn study table, in display order, by group: made hands, draws, nothing. */
export const TURN_CATEGORIES = [
  { key: "full-house-plus", group: "made" },
  { key: "flush", group: "made" },
  { key: "straight", group: "made" },
  { key: "set-trips", group: "made" },
  { key: "two-pair", group: "made" },
  { key: "top-pair", group: "made" },
  { key: "middle-pair", group: "made" },
  { key: "weak-pair", group: "made" },
  { key: "combo-draw", group: "draws" },
  { key: "flush-draw", group: "draws" },
  { key: "straight-draw", group: "draws" },
  { key: "gutshot", group: "draws" },
  { key: "ace-high", group: "nothing" },
  { key: "no-pair", group: "nothing" },
] as const;
export type TurnCategory = (typeof TURN_CATEGORIES)[number]["key"];

/** The category of one combo on a turn board: its made hand, else its best draw, else its high card. */
export function turnCategory(hole: readonly [number, number], board: readonly number[]): TurnCategory {
  const made = madeHand(hole, board);
  switch (made?.class) {
    case "straight-flush":
    case "quads":
    case "full-house":
      return "full-house-plus";
    case "flush":
      return "flush";
    case "straight":
      return "straight";
    case "set":
    case "trips":
      return "set-trips";
    case "two-pair":
      return "two-pair";
    case "overpair":
    case "top-pair":
      return "top-pair";
    case "second-pair":
    case "pocket-pair-below-top":
      return "middle-pair";
    case "weak-pair":
    case "underpair":
      return "weak-pair";
    default: {
      const found = draws(hole, board);
      const flush = found.includes("flush-draw") || found.includes("nut-flush-draw");
      const straight = found.includes("oesd");
      const gutshot = found.includes("gutshot");
      if (flush && (straight || gutshot)) return "combo-draw";
      if (flush) return "flush-draw";
      if (straight) return "straight-draw";
      if (gutshot) return "gutshot";
      return made?.class === "ace-high" ? "ace-high" : "no-pair";
    }
  }
}

/** The study view of a hero turn node: the hero's whole range there, as the solve plays it. */
export function turnStudyAt(solve: TurnSolve, nodeIndex: number): RiverStudy {
  return studyAt(solve, nodeIndex, "turn", TURN_CATEGORIES, turnCategory);
}
