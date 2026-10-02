/**
 * River grading with our solver (phase A4, `docs/ANALYSIS-PLAN.md` §3.2–§3.5).
 *
 * ```
 * rangeWalk (river start) ─▶ solveRiver (lib/solver) ─▶ the real river line, mapped onto the tree
 *                                                    └▶ the hero's combo at its node: strategy + EV per action
 *                                                       ─▶ options, grade() (§2), source "solver"
 * ```
 *
 * **The subgame.** Both ranges as the river card came (`rangeWalk.ts`), the
 * pot and the effective stack at the start of the river, the out-of-position
 * player first, the charts' rake profile, and one fixed bet menu for both
 * players (§3.2): bets of 33, 75 and 150% of the pot and all-in; raises of 75%
 * and all-in; at most `RIVER_RAISE_CAP` raises. Big blinds throughout, so
 * every EV comes back in big blinds, net from the start of the river with the
 * pot counted as winnable.
 *
 * **Solved once per hand.** Every hero river decision is a node of the same
 * game, so a hand with a check and then a call is one solve read twice. DCFR
 * runs to `RIVER_TARGET_PCT` (0.5% of the pot) or `RIVER_MAX_ITERATIONS`,
 * whichever comes first; the exploitability reached is stored with the grade.
 * Deterministic: same hand, same ranges, same bits — which is why the hand
 * view's re-solve for the study grid equals the stored row.
 *
 * **The real line onto the tree** (§3.3). Checks and calls map to themselves.
 * A bet or raise maps by pseudo-harmonic translation onto the node's sizes,
 * to the likelier side; an all-in (or anything that puts the effective stack
 * in) maps to the all-in. An opponent's size the solve (almost) never uses is
 * remapped to the nearest size it does use, so a translation never lands the
 * hero in a node its strategy never reached. Any size further than 25% of the
 * pot from where it was mapped is `off-tree-size` and caps the grade at
 * Inaccurate; nearer but not exact is `size-translated`.
 *
 * **The hero's own size** maps onto the one or two neighbouring sizes the
 * same way and is graded as the better of them: a size between two solved
 * ones is not worse than both.
 *
 * **What is stored** (§3.4): the options at the node for the hero's combo,
 * the grade, and a few numbers about the spot (`RiverFacts`). Never the
 * strategy: `riverStudy` re-solves when the reader asks for the grid.
 */

import type { ChartSet } from "../charts";
import { cardCode } from "../equity/evaluator";
import type { PhfHand } from "../phf/types";
import {
  COMBO_CLASS,
  comboHi,
  comboIndex,
  comboLo,
  HAND_CLASSES,
  NUM_COMBOS,
  OFF_TREE_DISTANCE,
  rangesAt,
  solveRiver,
  spotHash,
  spotKey,
  STANDARD_RAKE,
  translateSize,
  type BetMenu,
  type SolvedNode,
  type SolveResult,
} from "../solver";
import { grade, gradeRank, type GradeResult } from "./grading";
import { handStrength, streetStrength, type StreetStrength } from "./narrowing";
import type { PlayerRanges } from "./rangeWalk";
import { draws, madeHand } from "./texture";
import type {
  Approximation,
  OptionAnalysis,
  RangeShape,
  RiverFacts,
  RiverRole,
  RiverSkipReason,
} from "./types";

/* ------------------------------------------------------------ constants - */

/** The river bet menu (§3.2), the same for both players. */
export const RIVER_MENU: Readonly<BetMenu> = { bet: [0.33, 0.75, 1.5], raise: [0.75], allIn: true };
/** Its profile id, part of the spot key. */
export const RIVER_TREE = "river-m1";
/**
 * Raises after the first bet (§3.2: cap 2–3). Two: bet, raise, re-raise, then
 * only fold or call. A third river raise is rare in real hands and cost ~20%
 * more solve time over the owner's library for no change in the grades.
 */
export const RIVER_RAISE_CAP = 2;
/** A size leaving less than this × the pot after the call behind is all-in. */
export const RIVER_ALLIN_THRESHOLD = 0.1;
/** Smallest bet, in big blinds. */
export const RIVER_MIN_BET = 1;
/** Solve to this exploitability, % of the pot (§3.2). */
export const RIVER_TARGET_PCT = 0.5;
/** …or stop here. */
export const RIVER_MAX_ITERATIONS = 2000;
export const RIVER_CHECK_EVERY = 10;
/** Combos under this share of a range's heaviest combo are dropped before solving: they cost time and change nothing. */
export const PRUNE_SHARE = 0.002;
/** A line under this share of either range (2%) is noise (`river-unreached`): the strategy there is a best response to a sliver. */
export const MIN_LINE_REACH = 0.02;
/** An opponent's size the solve takes less often than this is remapped to one it uses. */
export const MIN_ACTION_FREQ = 0.01;
/** A size mapped further than this (fraction of the pot) is `size-translated`. */
export const TRANSLATED_DISTANCE = 0.02;
/** Strength buckets against a range: strong from here… */
export const STRONG_HS = 0.75;
/** …weak below here. */
export const WEAK_HS = 0.25;

const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/* ------------------------------------------------------------- the line - */

/** One river decision of either player, in big blinds. */
export interface RiverAct {
  index: number;
  seat: number;
  type: "fold" | "check" | "call" | "bet" | "raise";
  /** The actor's river total after the action. */
  to: number;
  allIn: boolean;
  /** Pot before the action, every chip in. */
  pot: number;
  toCall: number;
  /** A bet over the pot; a raise's increment over the pot after the call. Null otherwise. */
  sizePot: number | null;
}

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const NOT_MONEY = new Set(["collect", "cashout-pay", "cashout-choose", "show", "muck"]);

/** The river's decisions, with the money before each. */
export function riverActs(hand: PhfHand): RiverAct[] {
  const bb = Math.max(1, hand.game.bigBlind);
  const out: RiverAct[] = [];
  let pot = 0;
  let street: string | null = null;
  let totals = new Map<number, number>();
  let high = 0;
  for (const action of hand.actions) {
    if (action.street !== street) {
      street = action.street;
      totals = new Map();
      high = 0;
    }
    if (action.seat === null || NOT_MONEY.has(action.type)) continue;
    if (action.street === "river" && DECISIONS.has(action.type)) {
      const mine = totals.get(action.seat) ?? 0;
      const toCall = Math.max(0, high - mine);
      const to = mine + action.amount;
      let sizePot: number | null = null;
      if (action.type === "bet") sizePot = pot > 0 ? action.amount / pot : null;
      if (action.type === "raise") sizePot = pot + toCall > 0 ? Math.max(0, to - high) / (pot + toCall) : null;
      out.push({
        index: action.index,
        seat: action.seat,
        type: action.type as RiverAct["type"],
        to: to / bb,
        allIn: action.allIn,
        pot: pot / bb,
        toCall: toCall / bb,
        sizePot,
      });
    }
    pot += action.amount;
    if (action.type !== "ante" && action.type !== "bomb-ante" && action.type !== "uncalled") {
      const total = (totals.get(action.seat) ?? 0) + action.amount;
      totals.set(action.seat, total);
      high = Math.max(high, total);
    }
  }
  return out;
}

/* ------------------------------------------------------------ the solve - */

export interface RiverSpotInput {
  hand: PhfHand;
  heroSeat: number;
  villainSeat: number;
  /** The hero acts first on the river (is out of position). */
  heroFirst: boolean;
  heroCards: readonly [number, number];
  board: readonly number[];
  /** Pot and effective stack at the start of the river, bb. */
  potBb: number;
  stackBb: number;
  ranges: PlayerRanges;
  charts: ChartSet | null;
  /** The narrowing model the ranges came from, e.g. `heuristic/2`. */
  model: string;
  /** For the spot key. */
  key: { players: number; stackBucket: string; preflopLine: string; positions: readonly [string, string] };
}

export interface RiverSolve {
  ok: true;
  result: SolveResult;
  /** The hero's player index in the solve (0 acts first). */
  hero: 0 | 1;
  /** The hero's combo and its index among `result.hands[hero]`. */
  heroCombo: number;
  heroHand: number;
  /** The hero's combo was not in its own narrowed range; it was added at the pruning floor. */
  outOfRange: boolean;
  rake: string;
  spot: string;
  input: RiverSpotInput;
}

export type RiverFailure = { ok: false; reason: RiverSkipReason; detail: string };

interface RakeInfo {
  name: string;
  percent: number;
  cap: number;
}

/** The charts' rake profile (`model.rake`), or the solver's standard one. */
export function rakeOf(charts: ChartSet | null): RakeInfo {
  const raw = (charts?.model as { rake?: { name?: unknown; percent?: unknown; capBb?: unknown } } | undefined)?.rake;
  if (raw && typeof raw.percent === "number" && typeof raw.capBb === "number" && typeof raw.name === "string") {
    return { name: raw.name, percent: raw.percent, cap: raw.capBb };
  }
  return { name: STANDARD_RAKE.name, percent: STANDARD_RAKE.percent, cap: STANDARD_RAKE.capBb };
}

/** Drops the combos under `PRUNE_SHARE` of the heaviest. A copy. */
function pruned(range: Float64Array): Float64Array {
  let max = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) max = Math.max(max, range[c]);
  const out = new Float64Array(NUM_COMBOS);
  const floor = max * PRUNE_SHARE;
  for (let c = 0; c < NUM_COMBOS; c += 1) if (range[c] >= floor && range[c] > 0) out[c] = range[c];
  return out;
}

/** Solves the river of a heads-up hand. */
export function solveRiverSpot(input: RiverSpotInput): RiverSolve | RiverFailure {
  const heroCombo = comboIndex(input.heroCards[0], input.heroCards[1]);
  // Weights stay what the walk made them — the probability of holding each
  // combo given the line, in [0, 1] — so a range's sum is its size in combos.
  const heroRange = pruned(input.ranges.hero);
  const villainRange = pruned(input.ranges.villain);
  const outOfRange = !(heroRange[heroCombo] > 0);
  if (outOfRange) {
    let max = 0;
    for (let c = 0; c < NUM_COMBOS; c += 1) max = Math.max(max, heroRange[c]);
    heroRange[heroCombo] = Math.max(max * PRUNE_SHARE, 1e-9);
  }
  const ranges: [Float64Array, Float64Array] = input.heroFirst ? [heroRange, villainRange] : [villainRange, heroRange];
  const rake = rakeOf(input.charts);
  if (!(input.potBb > 0) || !(input.stackBb > 0)) {
    return { ok: false, reason: "river-off-tree", detail: "nothing behind to bet" };
  }

  let result: SolveResult;
  try {
    result = solveRiver(
      {
        board: [...input.board],
        ranges,
        pot: input.potBb,
        stack: input.stackBb,
        firstToAct: 0,
        menus: [RIVER_MENU, RIVER_MENU],
        raiseCap: RIVER_RAISE_CAP,
        allInThreshold: RIVER_ALLIN_THRESHOLD,
        minBet: RIVER_MIN_BET,
        rake: { percent: rake.percent, cap: rake.cap },
        bigBlind: 1,
      },
      { maxIterations: RIVER_MAX_ITERATIONS, targetExploitability: RIVER_TARGET_PCT, checkEvery: RIVER_CHECK_EVERY },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: /empty/.test(message) ? "river-range-empty" : "river-solve-failed", detail: message };
  }
  const hero: 0 | 1 = input.heroFirst ? 0 : 1;
  const heroHand = result.hands[hero].indexOf(heroCombo);
  if (heroHand < 0) return { ok: false, reason: "river-solve-failed", detail: "the hero's combo is not in the solve" };

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
        tree: RIVER_TREE,
        ranges,
      }),
    );
  } catch {
    spot = "";
  }
  return { ok: true, result, hero, heroCombo, heroHand, outOfRange, rake: rake.name, spot, input };
}

/* ------------------------------------------------------ line onto tree - */

interface Mapped {
  /** Edge index at the node. */
  edges: number[];
  /** Probability of each, from the translation (one edge: 1). */
  weights: number[];
  /** How far the real size is from the edge taken, fraction of the pot. */
  distance: number;
}

const SIZED = new Set(["bet", "raise", "allin"]);

/**
 * The edge(s) a real action takes at `node`. A sized action returns its
 * translation's edges, likelier first; `null` when the node has no such edge.
 */
function mapAct(node: SolvedNode, act: RiverAct, stack: number): Mapped | null {
  const kinds = node.actions.map((action) => action.kind);
  if (act.type === "check" || act.type === "call" || act.type === "fold") {
    const edge = kinds.indexOf(act.type);
    return edge < 0 ? null : { edges: [edge], weights: [1], distance: 0 };
  }
  const sized = node.actions.map((action, edge) => ({ action, edge })).filter(({ action }) => SIZED.has(action.kind));
  if (sized.length === 0) return null;
  const allIn = sized.find(({ action }) => action.kind === "allin");
  // Everything the effective stack allows is in: the tree's all-in.
  if (act.allIn || act.to >= stack - 1e-6) {
    const target = allIn ?? sized[sized.length - 1];
    return { edges: [target.edge], weights: [1], distance: 0 };
  }
  const x = act.sizePot ?? 0;
  const translation = translateSize(
    x,
    sized.map(({ action }) => action.sizePot),
  );
  const ordered = [...translation.mapped].sort((a, b) => b.probability - a.probability || a.size - b.size);
  return {
    edges: ordered.map((m) => sized[m.index].edge),
    weights: ordered.map((m) => m.probability),
    distance: Math.abs(sized[ordered[0].index].action.sizePot - x),
  };
}

export interface LineOnTree {
  ok: true;
  /** Result index of the hero's decision node. */
  node: number;
  /** The furthest any earlier size in the line was mapped, fraction of the pot; 0 when nothing was. */
  distance: number;
  /** Share of each range (by weight at the start of the river) that reaches the node. */
  reach: { hero: number; villain: number };
}

/**
 * Follows the river's actions before the hero's decision through the solved
 * tree. `acts` are the river decisions before it, in order.
 */
export function followLine(solve: RiverSolve, acts: readonly RiverAct[]): LineOnTree | RiverFailure {
  const { result, input } = solve;
  const firstSeat = input.heroFirst ? input.heroSeat : input.villainSeat;
  let at = 0;
  let distance = 0;
  for (const act of acts) {
    const node = result.nodes[at];
    const player = act.seat === firstSeat ? 0 : 1;
    if (!node || node.kind !== "action" || node.player !== player) {
      return { ok: false, reason: "river-off-tree", detail: `no decision for ${act.type} at ${node?.path ?? "?"}` };
    }
    const mapped = mapAct(node, act, input.stackBb);
    if (!mapped) return { ok: false, reason: "river-off-tree", detail: `no ${act.type} at ${node.path || "the root"}` };
    let edge = mapped.edges[0];
    let gap = mapped.distance;
    // The opponent's size: one the solve actually uses.
    if (act.seat !== input.heroSeat && SIZED.has(node.actions[edge].kind) && node.frequency[edge] < MIN_ACTION_FREQ) {
      // Measured from the real size, or from the all-in's when it was one.
      const x = mapped.distance === 0 && node.actions[edge].kind === "allin" ? node.actions[edge].sizePot : (act.sizePot ?? 0);
      const used = node.actions
        .map((action, e) => ({ action, e }))
        .filter(({ action, e }) => SIZED.has(action.kind) && node.frequency[e] >= MIN_ACTION_FREQ)
        .sort((a, b) => Math.abs(a.action.sizePot - x) - Math.abs(b.action.sizePot - x) || a.e - b.e);
      if (used.length > 0) {
        edge = used[0].e;
        gap = Math.abs(used[0].action.sizePot - x);
      }
    }
    distance = Math.max(distance, gap);
    const next = node.children[edge];
    if (next < 0) return { ok: false, reason: "river-off-tree", detail: `the line ends at ${node.labels[edge]}` };
    at = next;
  }
  const node = result.nodes[at];
  if (!node || node.kind !== "action" || node.player !== solve.hero) {
    return { ok: false, reason: "river-off-tree", detail: "the hero does not act here in the tree" };
  }
  // Both players must actually reach the node.
  const reach = rangesAt(result, at);
  const shares: [number, number] = [0, 0];
  for (const p of [0, 1] as const) {
    let start = 0;
    let now = 0;
    for (let i = 0; i < reach[p].length; i += 1) {
      start += result.weights[p][i];
      now += reach[p][i];
    }
    shares[p] = start > 0 ? now / start : 0;
    if (!(start > 0) || shares[p] < MIN_LINE_REACH) {
      return {
        ok: false,
        reason: "river-unreached",
        detail: `${p === solve.hero ? "the hero's" : "the opponent's"} range reaches ${node.path || "the root"} ${round4(shares[p])} of the time`,
      };
    }
  }
  return { ok: true, node: at, distance, reach: { hero: shares[solve.hero], villain: shares[1 - solve.hero] } };
}

/* ---------------------------------------------------------------- grade - */

/** The tree's options at a node for one hand, in the analysis vocabulary. */
export function optionsAt(result: SolveResult, node: SolvedNode, hand: number): OptionAnalysis[] {
  const n = result.hands[node.player].length;
  return node.actions.map((action, a) => {
    const base: OptionAnalysis = {
      action:
        action.kind === "allin"
          ? node.toCall > 0
            ? "raise"
            : "bet"
          : (action.kind as OptionAnalysis["action"]),
      freq: round4(node.strategy[a * n + hand]),
      ev: round3(node.ev[a * n + hand]),
    };
    if (action.kind === "allin") base.allIn = true;
    if (SIZED.has(action.kind)) {
      base.sizeBb = round2(action.to);
      base.size = round2(action.amount);
      base.sizePot = round3(action.sizePot);
    }
    return base;
  });
}

export interface RiverGrade extends GradeResult {
  ok: true;
  options: OptionAnalysis[];
  chosen: number;
  approximations: Approximation[];
  river: RiverFacts;
  /** The opponent's range at the node (1,326 weights, the hero's cards removed), for the equity fact. */
  villainRange: Float64Array;
}

/** HS of every combo against `range` on the river board. */
function strengthAgainst(strength: StreetStrength, range: Float64Array): Float64Array {
  return handStrength(strength, range);
}

/** A solve's per-hand reach at a node as 1,326 weights. */
function toCombos(result: SolveResult, p: 0 | 1, reach: Float64Array): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  const hands = result.hands[p];
  for (let i = 0; i < hands.length; i += 1) out[hands[i]] = reach[i];
  return out;
}

function withoutCards(range: Float64Array, cards: readonly number[]): Float64Array {
  const out = Float64Array.from(range);
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    if (out[c] > 0 && (cards.includes(comboHi(c)) || cards.includes(comboLo(c)))) out[c] = 0;
  }
  return out;
}

function shapeOf(strong: number, medium: number, weak: number): RangeShape {
  if (medium < 0.3 && strong >= 0.2 && weak >= 0.15) return "polar";
  if (medium >= 0.45) return "merged";
  return "mixed";
}

function roleOf(beats: number, facingBet: boolean): RiverRole {
  if (facingBet) {
    if (beats >= STRONG_HS) return "value";
    if (beats >= 0.1) return "bluff-catcher";
    return "weak";
  }
  if (beats >= 0.65) return "value";
  if (beats >= 0.5) return "thin-value";
  if (beats >= WEAK_HS) return "showdown";
  return "air";
}

export interface NodeRanges {
  /** Each player's reach at the node, as 1,326 weights. */
  hero: Float64Array;
  villain: Float64Array;
  strength: StreetStrength;
}

/** Both ranges at a node of the solve, as combos, and the board's strengths. */
export function nodeRanges(solve: RiverSolve, node: number): NodeRanges {
  const reach = rangesAt(solve.result, node);
  const villain = (1 - solve.hero) as 0 | 1;
  return {
    hero: toCombos(solve.result, solve.hero, reach[solve.hero]),
    villain: toCombos(solve.result, villain, reach[villain]),
    strength: streetStrength(solve.input.board),
  };
}

/**
 * Grades the hero's river decision at `line.node`. `act` is what the hero did.
 */
export function gradeRiver(
  solve: RiverSolve,
  line: LineOnTree,
  act: RiverAct,
): RiverGrade | RiverFailure {
  const { result } = solve;
  const node = result.nodes[line.node];
  const options = optionsAt(result, node, solve.heroHand);
  const mapped = mapAct(node, act, solve.input.stackBb);
  if (!mapped) return { ok: false, reason: "river-off-tree", detail: `no ${act.type} for the hero at ${node.path}` };

  const offTree = Math.max(line.distance, mapped.distance) > OFF_TREE_DISTANCE;
  // EV loss is quoted against the real pot before the decision, the one the
  // reader sees (`facts.potBb`), even when a translated size put the tree's elsewhere.
  const pot = act.pot;
  // The hero's own size: graded as the better of its neighbours.
  let chosen = mapped.edges[0];
  let graded: GradeResult | null = null;
  for (const edge of mapped.edges) {
    const candidate = grade({ options, chosen: edge, pot, capAtInaccurate: offTree });
    if (
      !graded ||
      gradeRank(candidate.grade) < gradeRank(graded.grade) ||
      (candidate.grade === graded.grade && candidate.evLoss < graded.evLoss - 1e-12)
    ) {
      graded = candidate;
      chosen = edge;
    }
  }
  if (!graded) return { ok: false, reason: "river-off-tree", detail: "nothing to grade against" };

  // The spot, for the *why*.
  const ranges = nodeRanges(solve, line.node);
  const heroCards = [...solve.input.heroCards];
  const villainSeen = withoutCards(ranges.villain, heroCards);
  const heroHs = strengthAgainst(ranges.strength, villainSeen);
  const beats = heroHs[solve.heroCombo];
  const villainHs = strengthAgainst(ranges.strength, ranges.hero);
  let strong = 0;
  let medium = 0;
  let weak = 0;
  let strongAll = 0;
  let weakAll = 0;
  let total = 0;
  let villainCombos = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = ranges.villain[c];
    if (!(w > 0) || Number.isNaN(villainHs[c])) continue;
    const blocked = heroCards.includes(comboHi(c)) || heroCards.includes(comboLo(c));
    if (villainHs[c] >= STRONG_HS) strongAll += w;
    else if (villainHs[c] < WEAK_HS) weakAll += w;
    if (blocked) continue;
    total += w;
    villainCombos += w;
    if (villainHs[c] >= STRONG_HS) strong += w;
    else if (villainHs[c] < WEAK_HS) weak += w;
    else medium += w;
  }
  // Combos are weights relative to the heaviest at the start (1 = all of a combo), so
  // their sum is the number of combos the range holds.
  let heroCombos = 0;
  for (let c = 0; c < NUM_COMBOS; c += 1) heroCombos += ranges.hero[c];
  const share = (x: number) => (total > 0 ? round3(x / total) : 0);
  const villain = {
    strong: share(strong),
    medium: share(medium),
    weak: share(weak),
    shape: shapeOf(share(strong), share(medium), share(weak)),
  };

  const approximations = new Set<Approximation>(["narrowing-heuristic", "rake-profile"]);
  const distance = Math.max(line.distance, mapped.distance);
  if (offTree) approximations.add("off-tree-size");
  else if (distance > TRANSLATED_DISTANCE) approximations.add("size-translated");
  if (result.exploitabilityPct > RIVER_TARGET_PCT) approximations.add("solver-unconverged");
  if (solve.outOfRange) approximations.add("out-of-range");

  const river: RiverFacts = {
    model: solve.input.model,
    tree: RIVER_TREE,
    rake: solve.rake,
    path: node.path,
    iterations: result.iterations,
    exploitabilityPct: round3(result.exploitabilityPct),
    converged: result.exploitabilityPct <= RIVER_TARGET_PCT,
    spot: solve.spot,
    heroCombos: round2(heroCombos),
    villainCombos: round2(villainCombos),
    heroBeats: Number.isNaN(beats) ? 0 : round3(beats),
    role: roleOf(Number.isNaN(beats) ? 0 : beats, node.toCall > 0),
    villain,
    blocks: {
      strong: strongAll > 0 ? round3(1 - strong / strongAll) : 0,
      weak: weakAll > 0 ? round3(1 - weak / weakAll) : 0,
    },
    translated: distance > TRANSLATED_DISTANCE ? round3(distance) : null,
    reach: { hero: round3(line.reach.hero), villain: round3(line.reach.villain) },
  };

  return {
    ok: true,
    options,
    chosen,
    approximations: [...approximations].sort(),
    river,
    villainRange: villainSeen,
    grade: graded.grade,
    evLoss: round3(graded.evLoss),
    evLossPot: Number.isFinite(graded.evLossPot) ? round4(graded.evLossPot) : 1,
    freqDiff: round4(graded.freqDiff),
    score: round2(graded.score),
  };
}

/* ---------------------------------------------------------------- study - */

/** Hand categories of the study table (§6.1), in display order, by group. */
export const RIVER_CATEGORIES = [
  { key: "full-house-plus", group: "made" },
  { key: "flush", group: "made" },
  { key: "straight", group: "made" },
  { key: "set-trips", group: "made" },
  { key: "two-pair", group: "made" },
  { key: "top-pair", group: "made" },
  { key: "middle-pair", group: "made" },
  { key: "weak-pair", group: "made" },
  { key: "missed-flush-draw", group: "missed" },
  { key: "missed-straight-draw", group: "missed" },
  { key: "ace-high", group: "nothing" },
  { key: "no-pair", group: "nothing" },
] as const;
export type RiverCategory = (typeof RIVER_CATEGORIES)[number]["key"];

/** The category of one combo on a river board (`turn`: the board before the river card). */
export function riverCategory(hole: readonly [number, number], board: readonly number[]): RiverCategory {
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
      const turnDraws = draws(hole, board.slice(0, 4));
      if (turnDraws.includes("flush-draw") || turnDraws.includes("nut-flush-draw")) return "missed-flush-draw";
      if (turnDraws.includes("oesd") || turnDraws.includes("gutshot")) return "missed-straight-draw";
      return made?.class === "ace-high" ? "ace-high" : "no-pair";
    }
  }
}

export interface StudyOption {
  action: OptionAnalysis["action"];
  allIn: boolean;
  sizeBb: number | null;
  sizePot: number | null;
  /** Share of the actor's range at the node that takes it. */
  share: number;
  combos: number;
}

export interface StudyRow {
  /** Weighted combos. */
  combos: number;
  /** Per option, the reach-weighted mix. Sums to 1 when `combos > 0`. */
  freq: number[];
  /** Per option, the reach-weighted mean EV (bb). */
  ev: number[];
}

export interface RiverStudy {
  path: string;
  pot: number;
  toCall: number;
  board: string[];
  options: StudyOption[];
  /** 169 cells, grid order (`HAND_CLASSES`). */
  cells: StudyRow[];
  heroClass: string;
  heroCombo: string;
  hero: { freq: number[]; ev: number[] };
  categories: Array<{ key: RiverCategory; group: string } & StudyRow>;
  /** The hero's range by strength against the opponent's range at the node. */
  strength: Array<{ key: "strong" | "medium" | "weak" } & StudyRow>;
  /** The opponent's range at the node (the hero's cards removed). */
  villain: {
    combos: number;
    categories: Array<{ key: RiverCategory; group: string; combos: number; share: number }>;
    strength: { strong: number; medium: number; weak: number };
  };
  iterations: number;
  exploitabilityPct: number;
}

function emptyRow(actions: number): StudyRow {
  return { combos: 0, freq: new Array(actions).fill(0), ev: new Array(actions).fill(0) };
}

function finish(row: StudyRow): StudyRow {
  if (row.combos > 0) {
    row.freq = row.freq.map((f) => round4(f / row.combos));
    row.ev = row.ev.map((e) => round3(e / row.combos));
  }
  row.combos = round2(row.combos);
  return row;
}

/** The study view of the hero's decision node: the hero's whole range, as the solve plays it. */
export function riverStudyAt(solve: RiverSolve, nodeIndex: number): RiverStudy {
  const { result } = solve;
  const node = result.nodes[nodeIndex];
  const p = node.player as 0 | 1;
  const n = result.hands[p].length;
  const actions = node.actions.length;
  const reach = rangesAt(result, nodeIndex);
  const ranges = nodeRanges(solve, nodeIndex);
  const board = [...solve.input.board];
  const heroCards = [...solve.input.heroCards];
  const villainSeen = withoutCards(ranges.villain, heroCards);
  const hsVsVillain = handStrength(ranges.strength, villainSeen);
  const villainHs = handStrength(ranges.strength, ranges.hero);

  const cells = HAND_CLASSES.map(() => emptyRow(actions));
  const categories = new Map<RiverCategory, StudyRow>(RIVER_CATEGORIES.map((c) => [c.key, emptyRow(actions)]));
  const buckets = { strong: emptyRow(actions), medium: emptyRow(actions), weak: emptyRow(actions) };
  const totals = new Array(actions).fill(0);
  let all = 0;
  for (let i = 0; i < n; i += 1) {
    const w = reach[p][i];
    if (!(w > 0)) continue;
    const combo = result.hands[p][i];
    const hole: [number, number] = [comboHi(combo), comboLo(combo)];
    const rows = [
      cells[COMBO_CLASS[combo]],
      categories.get(riverCategory(hole, board)) as StudyRow,
      hsVsVillain[combo] >= STRONG_HS ? buckets.strong : hsVsVillain[combo] < WEAK_HS ? buckets.weak : buckets.medium,
    ];
    all += w;
    for (const row of rows) row.combos += w;
    for (let a = 0; a < actions; a += 1) {
      const f = node.strategy[a * n + i];
      const e = node.ev[a * n + i];
      totals[a] += w * f;
      for (const row of rows) {
        row.freq[a] += w * f;
        row.ev[a] += w * e;
      }
    }
  }

  const villainCategories = new Map<RiverCategory, number>();
  let villainAll = 0;
  const villainStrength = { strong: 0, medium: 0, weak: 0 };
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const w = villainSeen[c];
    if (!(w > 0)) continue;
    const key = riverCategory([comboHi(c), comboLo(c)], board);
    villainCategories.set(key, (villainCategories.get(key) ?? 0) + w);
    villainAll += w;
    const hs = villainHs[c];
    if (hs >= STRONG_HS) villainStrength.strong += w;
    else if (hs < WEAK_HS) villainStrength.weak += w;
    else villainStrength.medium += w;
  }

  const heroRow = {
    freq: node.actions.map((_, a) => round4(node.strategy[a * n + solve.heroHand])),
    ev: node.actions.map((_, a) => round3(node.ev[a * n + solve.heroHand])),
  };
  const options: StudyOption[] = node.actions.map((action, a) => ({
    action: action.kind === "allin" ? (node.toCall > 0 ? "raise" : "bet") : (action.kind as OptionAnalysis["action"]),
    allIn: action.kind === "allin",
    sizeBb: SIZED.has(action.kind) ? round2(action.to) : null,
    sizePot: SIZED.has(action.kind) ? round3(action.sizePot) : null,
    share: all > 0 ? round4(totals[a] / all) : 0,
    combos: round2(totals[a]),
  }));
  const share = (x: number) => (villainAll > 0 ? round3(x / villainAll) : 0);

  return {
    path: node.path,
    pot: round2(node.pot),
    toCall: round2(node.toCall),
    board: board.map(cardCode),
    options,
    cells: cells.map(finish),
    heroClass: HAND_CLASSES[COMBO_CLASS[solve.heroCombo]].name,
    heroCombo: cardCode(comboHi(solve.heroCombo)) + cardCode(comboLo(solve.heroCombo)),
    hero: heroRow,
    categories: RIVER_CATEGORIES.map((c) => ({ key: c.key, group: c.group, ...finish(categories.get(c.key) as StudyRow) })).filter(
      (row) => row.combos > 0,
    ),
    strength: (["strong", "medium", "weak"] as const)
      .map((key) => ({ key, ...finish(buckets[key]) }))
      .filter((row) => row.combos > 0),
    villain: {
      combos: round2(villainAll),
      categories: RIVER_CATEGORIES.filter((c) => (villainCategories.get(c.key) ?? 0) > 0).map((c) => ({
        key: c.key,
        group: c.group,
        combos: round2(villainCategories.get(c.key) ?? 0),
        share: share(villainCategories.get(c.key) ?? 0),
      })),
      strength: {
        strong: share(villainStrength.strong),
        medium: share(villainStrength.medium),
        weak: share(villainStrength.weak),
      },
    },
    iterations: result.iterations,
    exploitabilityPct: round3(result.exploitabilityPct),
  };
}
