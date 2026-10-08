/**
 * From a real preflop line to a chart node and the hero's options.
 *
 * The analysis pipeline (phase A2b) calls `lookupPreflop` once per hero
 * preflop decision with the actions before it. The walk replays the real
 * actions on the chart's tree:
 *
 * - **Folds, checks and calls** map to the tree's edge of the same kind. A
 *   call the tree does not have (a fourth player into a pot, a cold call of
 *   a 3-bet, a limp past the tree's `maxLimpers` - `multiway` - or, in a set
 *   without limp trees, any open limp - `limp`) ends the walk with that reason.
 * - **Raises** map to the node's one raise size (or its all-in). The real size
 *   is compared with the chart's as a fraction of the pot - `(raise to - bet
 *   to match) / (pot after calling)` - through `lib/solver`'s
 *   `translateSize`, and recorded as a `sizing` approximation; more than 25%
 *   of the pot away from the chart's size is `offTree`, which caps the grade
 *   (ANALYSIS-PLAN §3.3).
 * - **Silent folds.** A player whose only option in the tree is to fold has
 *   no node; a real fold there is skipped, anything else is off the tree.
 *
 * Nothing is guessed: a line the tree cannot represent returns
 * `{ ok: false, reason }` and the decision is "not analysed".
 */

import { positionRing, type Position } from "../phf/types";
import { cardIndex } from "../equity";
import { classByName, classOfCards, HAND_CLASSES, NUM_CLASSES } from "../solver/handClasses";
import {
  buildPreflopTree,
  NINE_MAX,
  FLAG_COLD_CALL_CUT,
  FLAG_LIMP_CUT,
  FLAG_LIMPERS_CAP,
  FLAG_MULTIWAY_CAP,
  PF_ACTION,
  potAt,
  type PreflopPosition,
  type PreflopSizing,
  type PreflopTree,
} from "../solver/preflopTree";
import { OFF_TREE_DISTANCE, translateSize } from "../solver/translation";
import type { ChartAction, ChartNode, ChartPosition, ChartSet } from "./format";
import {
  effectiveStackBb,
  isChartLibrary,
  pickChartSet,
  STACK_NOTE_TOLERANCE,
  STACK_TOLERANCE,
  straddleMismatch,
} from "./registry";

export { STACK_NOTE_TOLERANCE, STACK_TOLERANCE };

/** One real preflop decision. */
export interface PreflopActionInput {
  position: Position;
  type: "fold" | "check" | "call" | "raise";
  /** Raise / call: the actor's total in for the street after the action, in bb. */
  toBb?: number;
  allIn?: boolean;
}

/** A hero decision to look up. */
export interface PreflopSpot {
  /** Positions dealt in, any order (`positionRing` names). */
  positions: readonly Position[];
  hero: Position;
  /** Every preflop decision before the hero's, in order, folds included. */
  actions: readonly PreflopActionInput[];
  /** Starting stacks in bb, by position. Missing stacks are taken as 100bb. */
  stacksBb?: Partial<Record<Position, number>>;
  ante?: boolean;
  /** Somebody straddled. */
  straddle?: boolean;
  /**
   * The straddles posted, in order: who and to how much (bb). A straddle set
   * (A2e) answers exactly one, by the first seat left of the big blind, of
   * its size; anything else is refused (`straddle`).
   */
  straddles?: readonly { position: Position; toBb: number }[];
}

export type ChartMissReason =
  | "straddle"
  | "ante"
  | "players"
  | "stack-depth"
  | "limp"
  | "multiway"
  | "cold-call"
  | "off-tree"
  | "rare-line"
  | "action-not-modelled"
  | "bad-input"
  | "unavailable";

export interface ChartApproximation {
  kind: "sizing" | "stack-depth" | "short-handed";
  detail: string;
  /** Stack depth: the chart set that answered (`ChartSet.id`). */
  set?: string;
  position?: Position;
  realBb?: number;
  chartBb?: number;
  /** Sizing: distance between the real and the chart size, as a fraction of the pot. */
  distance?: number;
  /** Sizing: further than `OFF_TREE_DISTANCE` - the grade is capped. */
  offTree?: boolean;
}

export interface ChartOption {
  action: ChartAction;
  /** What the hero has in after the action, bb. */
  sizeBb: number;
  freq: number;
  ev: number;
}

export type ChartLookup =
  | {
      ok: true;
      /** The set that answered: `charts` itself, or the library's set for this table and depth. */
      set: ChartSet;
      node: ChartNode;
      /** Hand class name, when a hand was given. */
      handClass: string | null;
      /**
       * How much of the hero's class the charts' range holds here (0..1), when a
       * hand was given. Below `OFF_RANGE` the hero got here by a line the
       * charts never take with this hand; the options are then the best
       * response to the charts, not an equilibrium mix.
       */
      inRange: number | null;
      /** The hero's options with its class's frequency and EV; empty without a hand. */
      options: ChartOption[];
      /** Index into `options` of the hero's real action, when given and modelled. */
      chosen: number | null;
      approximations: ChartApproximation[];
      /** Real options the tree removed at this node (`node.cut`). */
      unmodelled: ("call" | "limp")[];
    }
  | { ok: false; reason: ChartMissReason; detail: string };

const trees = new WeakMap<ChartSet, PreflopTree>();

/** The chart set's betting tree, rebuilt from its recorded assumptions. */
export function chartTree(charts: ChartSet): PreflopTree {
  let tree = trees.get(charts);
  if (!tree) {
    const model = charts.model as {
      tree?: { sizing?: PreflopSizing; maxEntrants?: number; sbLimp?: boolean; maxLimpers?: number };
    };
    const straddle = charts.game.straddle;
    tree = buildPreflopTree({
      // The builder takes table order; a straddle set stores action order.
      players: [...(charts.game.positions as PreflopPosition[])].sort((a, b) => NINE_MAX.indexOf(a) - NINE_MAX.indexOf(b)),
      ...(straddle ? { straddle: { position: straddle.position, bb: straddle.bb } } : {}),
      stackBb: charts.game.stackBb,
      sizing: model.tree?.sizing,
      maxEntrants: model.tree?.maxEntrants,
      sbLimp: model.tree?.sbLimp,
      maxLimpers: model.tree?.maxLimpers,
    });
    trees.set(charts, tree);
  }
  return tree;
}

/** Class index of a hand: `["Ah", "Kd"]`, `"AhKd"` or a class name `"AKo"`. */
export function handClassOf(hand: string | readonly string[]): number {
  if (Array.isArray(hand)) {
    if (hand.length !== 2) return -1;
    const a = cardIndex(hand[0]);
    const b = cardIndex(hand[1]);
    return a < 0 || b < 0 || a === b ? -1 : classOfCards(a, b);
  }
  const text = (hand as string).trim();
  if (text.length === 4) {
    const a = cardIndex(text.slice(0, 2));
    const b = cardIndex(text.slice(2));
    if (a >= 0 && b >= 0 && a !== b) return classOfCards(a, b);
  }
  return classByName(text);
}

const miss = (reason: ChartMissReason, detail: string): ChartLookup => ({ ok: false, reason, detail });

/**
 * A `k`-handed table's seats onto a set with at least `k` seats, by distance
 * from the button: the blinds are the blinds, the table's other seats are the
 * set's last ones, and the set's earliest seats fold first. Five-handed on
 * 6-max is UTG -> HJ with UTG folded; eight-handed on 9-max is UTG -> UTG+1,
 * UTG+1 -> UTG+2 with UTG folded.
 *
 * In the charts' own model this is exact up to convergence: a folded
 * player's range scales every other player's values by a constant per hand
 * class (card removal between opponents is ignored, docs/CHARTS.md §2), so
 * the game after the folds is the smaller table's game. What it leaves out
 * is the real effect of those folds (folded ranges hold fewer aces).
 */
function seatMap(
  positions: readonly Position[],
  seats: readonly ChartPosition[],
  straddler: ChartPosition | null = null,
): { rename: Map<Position, ChartPosition>; folded: ChartPosition[] } | null {
  const k = positions.length;
  const ring = positionRing(k);
  if (k < 3 || k > seats.length || ring.length !== k) return null;
  const given = new Set(positions);
  if (given.size !== k || ring.some((p) => !given.has(p))) return null;
  if (straddler) {
    // A straddle set (seats in action order, the straddler last): the table's
    // straddler (the first seat left of the big blind) is the set's, the
    // other seats are the set's last ones before the blinds, and the set's
    // first seats to act - the ones left of its straddler - fold first.
    if (k < 4) return null;
    const order = seats.filter((p) => p !== "SB" && p !== "BB" && p !== straddler);
    const others = ring.slice(3);
    if (order.length + 3 !== seats.length) return null;
    const skip = order.length - others.length;
    const rename = new Map<Position, ChartPosition>([
      ["SB", "SB"],
      ["BB", "BB"],
      [ring[2], straddler],
    ]);
    others.forEach((p, i) => rename.set(p, order[skip + i]));
    return { rename, folded: order.slice(0, skip) };
  }
  const table = ring.slice(2);
  const order = seats.filter((p) => p !== "SB" && p !== "BB");
  if (order.length + 2 !== seats.length) return null;
  const skip = order.length - table.length;
  const rename = new Map<Position, ChartPosition>([
    ["SB", "SB"],
    ["BB", "BB"],
  ]);
  table.forEach((p, i) => rename.set(p, order[skip + i]));
  return { rename, folded: order.slice(0, skip) };
}

/**
 * Looks up the chart node for a hero decision and, given the hero's hand, its
 * options. `heroAction` is the hero's real decision: it selects `chosen` and
 * adds the hero's own sizing approximation.
 */
export function lookupPreflop(
  charts: ChartSet,
  spot: PreflopSpot,
  hand?: string | readonly string[] | null,
  heroAction?: PreflopActionInput | null,
): ChartLookup {
  if (isChartLibrary(charts)) {
    // A straddle no set models is refused as one, ahead of everything else.
    const pick = pickChartSet(charts.specs, spot);
    if (!pick.ok && pick.reason === "straddle") return miss("straddle", pick.detail);
    if (spot.ante) return miss("ante", "antes are not modelled by the cash charts");
    if (!pick.ok) return miss(pick.reason, pick.detail);
    const set = charts.sets.get(pick.spec.id);
    if (!set) return miss("unavailable", `chart set ${pick.spec.id} is not loaded`);
    return lookupInSet(set, spot, hand, heroAction);
  }
  // One set: it answers only the straddle it models (none, or its own).
  const mismatch = straddleMismatch(charts.game.straddle ?? null, charts.game.positions.length, spot);
  if (mismatch) return miss("straddle", mismatch);
  if (spot.ante) return miss("ante", "antes are not modelled by the cash charts");
  return lookupInSet(charts, spot, hand, heroAction);
}

/** `lookupPreflop` on one set. */
function lookupInSet(
  charts: ChartSet,
  spot: PreflopSpot,
  hand?: string | readonly string[] | null,
  heroAction?: PreflopActionInput | null,
): ChartLookup {
  const tree = chartTree(charts);
  const approximations: ChartApproximation[] = [];

  // Positions onto the chart's seats.
  const seats = charts.game.positions;
  const straddle = charts.game.straddle ?? null;
  const mapped = seatMap(spot.positions, seats, straddle?.position ?? null);
  if (!mapped) {
    return miss(
      "players",
      spot.positions.length === 2
        ? "heads-up: the small blind is the button; no chart set models it"
        : `${spot.positions.length} players dealt in (${spot.positions.join(", ")}); the set is ${seats.length}-max`,
    );
  }
  const rename = (p: Position): ChartPosition | null => mapped.rename.get(p) ?? null;
  let line = "f".repeat(mapped.folded.length);
  if (mapped.folded.length) {
    approximations.push({
      kind: "short-handed",
      detail: `${spot.positions.length} players dealt in: read as ${seats.length}-max with ${mapped.folded.join(", ")} folded`,
    });
  }
  const hero = rename(spot.hero);
  if (!hero) return miss("bad-input", `hero position ${spot.hero} is not dealt in`);

  // Stack depth: the hero against the deepest opponent still in at the decision.
  const effective = effectiveStackBb(spot, charts.game.stackBb);
  const depth = charts.game.stackBb;
  if (Math.abs(effective - depth) > STACK_TOLERANCE * depth + 1e-9) {
    return miss("stack-depth", `effective stack ${round2(effective)}bb is outside ${depth}bb ±${STACK_TOLERANCE * 100}%`);
  }
  if (Math.abs(effective - depth) > STACK_NOTE_TOLERANCE * depth) {
    approximations.push({
      kind: "stack-depth",
      detail: `effective stack ${round2(effective)}bb, charts solved at ${depth}bb`,
      set: charts.id,
      realBb: round2(effective),
      chartBb: depth,
    });
  }

  // Replay.
  const real = new Map<ChartPosition, number>();
  real.set("SB", 0.5);
  real.set("BB", 1);
  let realToMatch = 1;
  if (straddle) {
    // The real straddle is the set's size (`straddleMismatch`).
    real.set(straddle.position, straddle.bb);
    realToMatch = straddle.bb;
  }
  let node = tree.lineIndex.get(line) ?? -1;
  if (node < 0) return miss("off-tree", "no root node");

  for (const action of spot.actions) {
    const position = rename(action.position);
    if (!position) return miss("bad-input", `unknown position ${action.position}`);
    if (tree.type[node] !== PF_ACTION) {
      // The tree closed the betting because four players are in: everyone
      // else could only fold. A real fold there is that fold; anything else
      // is a fifth entrant.
      if (action.type === "fold") continue;
      return miss("multiway", `${action.position} would be a fifth player in the pot; the tree only lets it fold`);
    }
    const actor = tree.players[tree.actor[node]];
    if (position !== actor) {
      // A player the tree folds silently (only fold was possible).
      if (action.type === "fold" && silentlyFolded(tree, line, node, position)) {
        line += "f";
        continue;
      }
      if (silentlyFolded(tree, line, node, position)) {
        return tree.level[node] >= 2
          ? miss("cold-call", `${action.position} enters a re-raised pot cold; the tree only lets it fold`)
          : miss("multiway", `${action.position} would be a fifth player in the pot; the tree only lets it fold`);
      }
      return miss("off-tree", `${action.position} acts out of the tree's order (expected ${actor})`);
    }
    const step = applyAction(tree, node, action, real, realToMatch, position);
    if (!step.ok) return step.miss;
    if (step.approximation) approximations.push(step.approximation);
    realToMatch = step.realToMatch;
    line += step.code;
    node = step.child;
  }

  if (tree.type[node] !== PF_ACTION) {
    return miss("multiway", `the pot has four players in; the tree only lets ${spot.hero} fold`);
  }
  if (tree.players[tree.actor[node]] !== hero) {
    return miss(
      "off-tree",
      `the tree has no decision for ${spot.hero} here (next to act: ${tree.players[tree.actor[node]]})`,
    );
  }
  const chart = charts.nodes.get(tree.line[node]);
  if (!chart) {
    return miss("rare-line", `line ${JSON.stringify(tree.line[node])} is in the tree but too rare to be in the chart set`);
  }

  const unmodelled: ("call" | "limp")[] = [];
  if (tree.flags[node] & (FLAG_MULTIWAY_CAP | FLAG_COLD_CALL_CUT)) unmodelled.push("call");
  if (tree.flags[node] & (FLAG_LIMP_CUT | FLAG_LIMPERS_CAP)) unmodelled.push("limp");

  // The hero's own action.
  let chosen: number | null = null;
  if (heroAction) {
    const step = applyAction(tree, node, heroAction, real, realToMatch, hero);
    if (!step.ok) {
      return miss("action-not-modelled", step.miss.ok ? "" : step.miss.detail);
    }
    if (step.approximation) approximations.push(step.approximation);
    chosen = chart.options.findIndex((o) => o.code === step.code);
  }

  const k = hand == null ? -1 : handClassOf(hand);
  if (hand != null && k < 0) return miss("bad-input", `not a hand: ${String(hand)}`);
  const options: ChartOption[] = [];
  if (k >= 0) {
    chart.options.forEach((option, a) => {
      options.push({
        action: option.action,
        sizeBb: option.toBb,
        freq: chart.freq[a * NUM_CLASSES + k],
        ev: chart.ev[a * NUM_CLASSES + k],
      });
    });
  }
  return {
    ok: true,
    set: charts,
    node: chart,
    handClass: k >= 0 ? HAND_CLASSES[k].name : null,
    inRange: k >= 0 ? chart.range[k] : null,
    options,
    chosen,
    approximations,
    unmodelled,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Whether `position` is a player the tree skipped (silent fold) between the previous step and `node`. */
function silentlyFolded(tree: PreflopTree, line: string, node: number, position: ChartPosition): boolean {
  // The tree's line at `node` is longer than the walked line by exactly the
  // silent folds; the position must be one of those players and still live
  // before them. Checking that the tree recorded extra folds is enough to
  // tell a silent fold from a player acting out of turn.
  const extra = tree.line[node].length - line.length;
  if (extra <= 0) return false;
  const k = tree.players.indexOf(position);
  return k >= 0 && (tree.live[node] & (1 << k)) === 0;
}

type Step =
  | {
      ok: true;
      code: string;
      child: number;
      realToMatch: number;
      approximation: ChartApproximation | null;
    }
  | { ok: false; miss: ChartLookup };

function applyAction(
  tree: PreflopTree,
  node: number,
  action: PreflopActionInput,
  real: Map<ChartPosition, number>,
  realToMatch: number,
  position: ChartPosition,
): Step {
  const start = tree.childStart[node];
  const count = tree.childCount[node];
  const edge = (codes: string[]) => {
    for (let e = start; e < start + count; e += 1) {
      if (codes.includes(tree.edgeCode[e])) return e;
    }
    return -1;
  };
  const fail = (reason: ChartMissReason, detail: string): Step => ({ ok: false, miss: miss(reason, detail) });
  const level = tree.level[node];
  const realIn = real.get(position) ?? 0;

  if (action.type === "fold") {
    const e = edge(["f"]);
    if (e < 0) return fail("off-tree", `${position} folds where it cannot`);
    return { ok: true, code: "f", child: tree.children[e], realToMatch, approximation: null };
  }
  if (action.type === "check") {
    const e = edge(["k"]);
    if (e < 0) return fail("off-tree", `${position} checks facing a bet`);
    return { ok: true, code: "k", child: tree.children[e], realToMatch, approximation: null };
  }
  if (action.type === "call") {
    const e = edge(["c"]);
    if (e < 0) {
      const flags = tree.flags[node];
      if (flags & FLAG_LIMP_CUT) return fail("limp", `${position} limps; only the small blind's limp is in the tree`);
      if (flags & FLAG_LIMPERS_CAP) {
        return fail("multiway", `${position} limps behind ${tree.maxLimpers} limpers; the tree models at most ${tree.maxLimpers}`);
      }
      if (flags & FLAG_COLD_CALL_CUT) return fail("cold-call", `${position} cold-calls a re-raise`);
      if (flags & FLAG_MULTIWAY_CAP) return fail("multiway", `${position} would be a fourth player in the pot`);
      return fail("off-tree", `${position} calls where the tree has no call`);
    }
    real.set(position, Math.max(realIn, realToMatch));
    return { ok: true, code: "c", child: tree.children[e], realToMatch, approximation: null };
  }
  // Raise.
  const e = edge(["r", "a"]);
  if (e < 0) return fail("off-tree", `${position} raises where the tree cannot (level ${level})`);
  const to = action.toBb;
  if (to === undefined || !(to > realToMatch)) {
    return fail("bad-input", `${position}'s raise has no size above ${realToMatch}bb`);
  }
  let realPot = 0;
  for (const v of real.values()) realPot += v;
  const realFraction = (to - realToMatch) / (realPot + (realToMatch - realIn));
  const n = tree.players.length;
  const chartIn = tree.contrib[node * n + tree.actor[node]];
  const chartTo = tree.edgeTo[e];
  const chartMatch = tree.toMatch[node];
  const chartFraction = (chartTo - chartMatch) / (potAt(tree, node) + (chartMatch - chartIn));
  const translation = translateSize(realFraction, [chartFraction]);
  real.set(position, to);
  const approximation: ChartApproximation | null =
    Math.abs(to - chartTo) > 0.01
      ? {
          kind: "sizing",
          detail: `${position} raised to ${round2(to)}bb; the chart's size is ${round2(chartTo)}bb`,
          position,
          realBb: round2(to),
          chartBb: chartTo,
          distance: Math.round(translation.distance * 1000) / 1000,
          offTree: translation.distance > OFF_TREE_DISTANCE,
        }
      : null;
  return { ok: true, code: tree.edgeCode[e], child: tree.children[e], realToMatch: to, approximation };
}
