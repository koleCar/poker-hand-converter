/**
 * The exploit lab (Learn L4): lock one player's strategy at a node, and read
 * the other player's best response against it.
 *
 * ```
 * a solved game (any: the toys, a river, a turn)
 *   ─▶ lockedStrategy: at a node, the locked player's share of a group of
 *      actions set to a number ("folds 65% to a bet", "never raises",
 *      "bets 5% of its air"), the hands moving in a stated order
 *   ─▶ exploitLab: the rest of the locked player's strategy stays the
 *      equilibrium's (frozen), and the other player best-responds
 *   ─▶ what the response gains over the equilibrium against that opponent,
 *      and what it gives back if the read is wrong: against the equilibrium
 *      opponent, and against the opponent's own best response to it
 * ```
 *
 * **A best response with one strategy frozen** is what exploitability already
 * measures (`Solver.exploitability`); the lab only changes the frozen
 * strategy first and keeps the response (`Solver.bestResponse`). It is not a
 * re-solve of the whole game with the lock in place: the locked player does
 * not adapt anywhere else, which is the honest model of "I read this player as
 * doing X, and nothing else changes".
 *
 * **Values** are the responder's expectation over every deal of both ranges,
 * in chips, as `Solver.value` gives them: for a river, bb per river played
 * from these ranges.
 *
 * Same import rule as the rest of `lib/solver`.
 */

import type { BestResponseRow, Solver } from "./cfr";
import type { SolveResult } from "./solve";
import { ACTION, CHANCE, type FlatTree } from "./tree";

/** One lock: at `node`, the locked player's share of `group` is `share`. */
export interface NodeLock {
  /** Tree node id of an action node of the locked player. */
  node: number;
  /** Action indices at the node whose combined share is locked ("fold"; "raise" and "all-in"; every bet). */
  group: readonly number[];
  /** The group's share of the locked hands, weighted by the player's own reach at the node, 0..1. */
  share: number;
  /**
   * The player's hands in the order they join the group when the share goes
   * up (the first joins first); they leave it in the reverse order when it
   * goes down. For "folds more", weakest first: a player who folds more folds
   * his worst hands first.
   */
  order: ArrayLike<number>;
  /** 1 for the hands the lock is about (its share is over them); the rest keep their strategy. All hands when absent. */
  mask?: ArrayLike<number>;
  /** Where a hand leaving the group goes when it plays nothing outside it (an action index outside the group). */
  fallback: number;
}

/**
 * The strategy at a node after a lock: `strategy` is `[action][hand]` with
 * `count` actions and `n` hands, `reach` the player's own reach per hand. The
 * group's share moves to `lock.share` exactly (unless no hand can move), and
 * the hands move whole in `lock.order`, the last one partly. A hand joining
 * the group splits what it moves like the group's own mix (its own if it
 * already plays the group, else the range's); a hand leaving splits it like
 * its own mix outside the group, else goes to `lock.fallback`.
 */
export function lockedStrategy(
  strategy: ArrayLike<number>,
  count: number,
  n: number,
  reach: ArrayLike<number>,
  lock: Pick<NodeLock, "group" | "share" | "order" | "mask" | "fallback">,
): Float32Array {
  const out = Float32Array.from(strategy as ArrayLike<number>);
  const inGroup = new Uint8Array(count);
  for (const a of lock.group) inGroup[a] = 1;
  const weight = (i: number) => (lock.mask && !lock.mask[i] ? 0 : Math.max(0, reach[i]));
  const groupShare = (i: number) => {
    let g = 0;
    for (let a = 0; a < count; a += 1) if (inGroup[a]) g += out[a * n + i];
    return g;
  };
  let total = 0;
  let current = 0;
  const rangeMix = new Float64Array(count);
  for (let i = 0; i < n; i += 1) {
    const w = weight(i);
    if (!(w > 0)) continue;
    total += w;
    current += w * groupShare(i);
    for (let a = 0; a < count; a += 1) if (inGroup[a]) rangeMix[a] += w * out[a * n + i];
  }
  if (!(total > 0)) return out;
  current /= total;
  const target = Math.min(1, Math.max(0, lock.share));
  let need = Math.abs(target - current) * total;
  if (need <= 1e-12 * total) return out;
  const up = target > current;
  const rangeGroup = lock.group.reduce((sum, a) => sum + rangeMix[a], 0);

  for (let k = 0; k < lock.order.length && need > 1e-12 * total; k += 1) {
    const i = lock.order[up ? k : lock.order.length - 1 - k];
    const w = weight(i);
    if (!(w > 0)) continue;
    const g = groupShare(i);
    const room = (up ? 1 - g : g) * w;
    if (!(room > 1e-15)) continue;
    const t = Math.min(1, need / room);
    need -= room * t;
    let moved = 0;
    for (let a = 0; a < count; a += 1) {
      if (Boolean(inGroup[a]) === up) continue;
      const m = out[a * n + i] * t;
      out[a * n + i] -= m;
      moved += m;
    }
    if (up) {
      // Into the group: like the hand's own group mix, else the range's, else the group's first action.
      for (const a of lock.group) {
        const share = g > 1e-12 ? out[a * n + i] / g : rangeGroup > 0 ? rangeMix[a] / rangeGroup : a === lock.group[0] ? 1 : 0;
        out[a * n + i] += moved * share;
      }
    } else {
      // Out of the group: like the hand's own mix outside it, else the fallback.
      const rest = 1 - g;
      for (let a = 0; a < count; a += 1) {
        if (inGroup[a]) continue;
        const share = rest > 1e-12 ? out[a * n + i] / rest : a === lock.fallback ? 1 : 0;
        out[a * n + i] += moved * share;
      }
    }
  }
  return out;
}

/** The share of `group` in a strategy, weighted by `reach` (and `mask`). */
export function groupShareOf(
  strategy: ArrayLike<number>,
  count: number,
  n: number,
  reach: ArrayLike<number>,
  group: readonly number[],
  mask?: ArrayLike<number>,
): number {
  if (strategy.length < count * n) return 0;
  let total = 0;
  let inside = 0;
  for (let i = 0; i < n; i += 1) {
    const w = mask && !mask[i] ? 0 : Math.max(0, reach[i]);
    if (!(w > 0)) continue;
    total += w;
    for (const a of group) inside += w * strategy[a * n + i];
  }
  return total > 0 ? inside / total : 0;
}

/**
 * Tree node ids in the order a full `SolveResult` lists its nodes (the
 * pre-order `extract` walks: decision and chance nodes, children by edge).
 */
export function resultNodeIds(tree: FlatTree): Int32Array {
  const out: number[] = [];
  const visit = (node: number) => {
    const type = tree.type[node];
    if (type !== ACTION && type !== CHANCE) return;
    out.push(node);
    const start = tree.childStart[node];
    for (let e = 0; e < tree.childCount[node]; e += 1) visit(tree.children[start + e]);
  };
  visit(tree.root);
  return Int32Array.from(out);
}

/**
 * Loads a full result's average strategies into a fresh solver of the same
 * game, so the lab can work on a solve that was made (and cached, or sent
 * from a worker) without running it again. Returns the tree node id of each
 * result node.
 */
export function loadResult(solver: Solver, result: SolveResult): Int32Array {
  const ids = resultNodeIds(solver.game.tree);
  if (ids.length !== result.nodes.length || (result.scope && result.scope !== "all")) {
    throw new Error("the result is not a full solve of this game");
  }
  result.nodes.forEach((node, k) => {
    if (node.kind === "action") solver.setAverageStrategy(ids[k], node.strategy);
  });
  return ids;
}

/**
 * Player `p`'s own reach at every action node of the tree, as the average
 * strategy plays it: initial weight times p's own action probabilities on the
 * way, with the hands that hold a dealt card removed. A map by node id.
 */
export function ownReach(solver: Solver, p: 0 | 1): Map<number, Float64Array> {
  const { tree, hands } = solver.game;
  const out = new Map<number, Float64Array>();
  const n = hands[p].size;
  const visit = (node: number, reach: Float64Array) => {
    const type = tree.type[node];
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    if (type === CHANCE) {
      for (let e = 0; e < count; e += 1) {
        const card = tree.edgeCard[start + e];
        const next = Float64Array.from(reach);
        for (let i = 0; i < n; i += 1) if (hands[p].c1[i] === card || hands[p].c2[i] === card) next[i] = 0;
        visit(tree.children[start + e], next);
      }
      return;
    }
    if (type !== ACTION) return;
    out.set(node, reach);
    if (tree.player[node] !== p) {
      for (let e = 0; e < count; e += 1) visit(tree.children[start + e], reach);
      return;
    }
    const strategy = solver.averageStrategy(node);
    for (let a = 0; a < count; a += 1) {
      const next = new Float64Array(n);
      for (let i = 0; i < n; i += 1) next[i] = reach[i] * strategy[a * n + i];
      visit(tree.children[start + a], next);
    }
  };
  visit(tree.root, Float64Array.from(hands[p].weight));
  return out;
}

export interface LabOptions {
  /**
   * The responder's best response keeps its equilibrium mix in a hand within
   * this many chips (EV) of its best action (`Solver.bestResponse`). 0 keeps
   * only exact ties.
   */
  keep?: number;
}

/** What `exploitLab` measures. Values are the responder's, in chips per deal. */
export interface LabResult {
  /** Both players at the equilibrium (the solve's average strategies). */
  equilibrium: number;
  /** The responder's equilibrium strategy against the locked opponent. */
  equilibriumVsLock: number;
  /** The responder's best response against the locked opponent. */
  bestVsLock: number;
  /** That best response against the equilibrium opponent (the read was wrong: the opponent plays the baseline). */
  bestVsEquilibrium: number;
  /** That best response against the opponent's own best response to it (the opponent adjusts and punishes it). */
  bestVsCounter: number;
  /** The equilibrium strategy against the opponent's best response to it: what the baseline can lose at worst. */
  equilibriumVsCounter: number;
  /** `bestVsLock - equilibriumVsLock`: what exploiting the read adds over playing the baseline against this opponent. */
  gain: number;
  /** `equilibrium - bestVsEquilibrium`: what the exploit gives up if the opponent actually plays the baseline. */
  riskVsEquilibrium: number;
  /** `equilibrium - bestVsCounter`: what the exploit gives up if the opponent sees it and counters. */
  riskVsCounter: number;
  /** `equilibrium - equilibriumVsCounter`: the same for the baseline (small: the solve's own exploitability). */
  baselineRisk: number;
  /** The locked player's strategy at each locked node, and its equilibrium strategy there. */
  locked: Map<number, { strategy: Float32Array; equilibrium: Float32Array }>;
  /** The responder's best response against the lock, by node (only nodes the walk reached). */
  response: Map<number, BestResponseRow>;
}

/**
 * Locks player `1 - responder` at `locks` and measures the responder's best
 * response (see the module comment). The solver ends as it started: its
 * average strategies are restored. Needs float32 storage.
 */
export function exploitLab(solver: Solver, responder: 0 | 1, locks: readonly NodeLock[], options: LabOptions = {}): LabResult {
  const tree = solver.game.tree;
  const locked = (1 - responder) as 0 | 1;
  const keep = options.keep ?? 0;
  const saved = solver.averageSnapshot();
  const install = (rows: Map<number, BestResponseRow>) => {
    for (const [node, row] of rows) solver.setAverageStrategy(node, row.strategy);
  };
  try {
    const equilibrium = solver.value(responder);

    // The baseline against its own worst case.
    install(solver.bestResponse(locked, -1).strategy);
    const equilibriumVsCounter = solver.value(responder);
    solver.restoreAverage(saved);

    // The lock.
    const reach = ownReach(solver, locked);
    const lockedRows = new Map<number, { strategy: Float32Array; equilibrium: Float32Array }>();
    for (const lock of locks) {
      if (tree.type[lock.node] !== ACTION || tree.player[lock.node] !== locked) {
        throw new Error(`node ${lock.node} is not a decision of the locked player`);
      }
      const count = tree.childCount[lock.node];
      const n = solver.game.hands[locked].size;
      const before = solver.averageStrategy(lock.node);
      const after = lockedStrategy(before, count, n, reach.get(lock.node) as Float64Array, lock);
      lockedRows.set(lock.node, { strategy: after, equilibrium: before });
    }
    for (const [node, row] of lockedRows) solver.setAverageStrategy(node, row.strategy);
    const equilibriumVsLock = solver.value(responder);

    // The response, kept, and installed.
    const response = solver.bestResponse(responder, keep).strategy;
    install(response);
    const bestVsLock = solver.value(responder);

    // The read was wrong: the opponent plays the baseline.
    for (const [node, row] of lockedRows) solver.setAverageStrategy(node, row.equilibrium);
    const bestVsEquilibrium = solver.value(responder);

    // The opponent sees the exploit and counters it.
    install(solver.bestResponse(locked, -1).strategy);
    const bestVsCounter = solver.value(responder);

    return {
      equilibrium,
      equilibriumVsLock,
      bestVsLock,
      bestVsEquilibrium,
      bestVsCounter,
      equilibriumVsCounter,
      gain: bestVsLock - equilibriumVsLock,
      riskVsEquilibrium: equilibrium - bestVsEquilibrium,
      riskVsCounter: equilibrium - bestVsCounter,
      baselineRisk: equilibrium - equilibriumVsCounter,
      locked: lockedRows,
      response,
    };
  } finally {
    solver.restoreAverage(saved);
  }
}
