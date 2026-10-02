/**
 * The worker-facing API: solve a spot, get back plain data.
 *
 * `solveRiver` / `solveTurn` take a `SpotInput`, run DCFR until the
 * exploitability target or the iteration cap, and return a `SolveResult` that
 * is nothing but numbers, strings, arrays and typed arrays - so it crosses
 * `postMessage` by structured clone (typed arrays can be transferred), and
 * `format.ts` turns it into a compact versioned blob for the shared cache.
 *
 * **What a result holds**, per decision node of the tree:
 *
 *  - the average strategy, `[action][hand]` for the acting player's hands;
 *  - the EV of each action for each hand (`[action][hand]`), in chips, as net
 *    winnings from the start of the street with the pot counted as winnable -
 *    EV loss for grading is `max(ev) - ev[chosen]` for the hero's combo;
 *  - how often the whole range takes each action (combo-weighted by the
 *    actor's own reach), for reports and the study view;
 *  - the pot, the amount to call and the stack behind, and each action's size
 *    as a fraction of the pot, which is what action translation needs to map a
 *    real bet onto this tree.
 *
 * Hands are listed once per player (`hands[p]`, combo indices) and every
 * per-hand array is in that order.
 */

import { cardCode } from "../equity";
import type { ActionInfo } from "./betting";
import { Solver, type DcfrParams, type RunOptions, type RunResult } from "./cfr";
import { comboHi, comboLo } from "./combos";
import { SOLVER_VERSION } from "./format";
import { buildRiverGame, buildTurnGame, type BuiltSubgame, type RiverSpot, type TurnSpot } from "./subgame";
import { ACTION, CHANCE } from "./tree";

export interface SolveOptions extends RunOptions {
  dcfr?: Partial<DcfrParams>;
}

export interface SolvedNode {
  kind: "action" | "chance";
  /** Acting player index; -1 for a chance node. */
  player: number;
  street: "turn" | "river";
  /** Labels from the root, e.g. `X-B6.5-C|7h|X`; `""` is the root. */
  path: string;
  /** Result index of the parent node, -1 at the root. */
  parent: number;
  /** Which of the parent's edges leads here. */
  parentEdge: number;
  /** Pot before this decision, including bets already in. 0 for chance. */
  pot: number;
  toCall: number;
  behind: number;
  /** Edge labels: action labels, or card codes for a chance node. */
  labels: string[];
  /** Action details; empty for a chance node. */
  actions: ActionInfo[];
  /** Result index of each edge's node, or -1 where the edge ends the hand. */
  children: number[];
  /** `[action][hand]` average strategy of the acting player. Empty for chance. */
  strategy: Float32Array;
  /** `[action][hand]` EV in chips. Empty for chance. */
  ev: Float32Array;
  /** Per action: share of the actor's range (by reach) that takes it. */
  frequency: number[];
}

export interface SolveResult {
  version: typeof SOLVER_VERSION;
  street: "river" | "turn";
  board: string[];
  pot: number;
  stack: number;
  firstToAct: 0 | 1;
  /** Combo indices per player; every per-hand array follows this order. */
  hands: [Uint16Array, Uint16Array];
  /** Initial range weight of each hand. */
  weights: [Float32Array, Float32Array];
  iterations: number;
  stoppedBy: RunResult["stoppedBy"];
  /** Chips a best responder gains on average per player (NashConv / 2). */
  exploitability: number;
  /** `exploitability` as a percentage of the pot. */
  exploitabilityPct: number;
  /** `exploitability` in thousandths of a big blind. */
  exploitabilityMbb: number;
  /** Each player's EV of the game, in chips. */
  value: [number, number];
  /** Each player's EV per hand at the root, in chips. */
  rootEv: [Float32Array, Float32Array];
  nodes: SolvedNode[];
  /** Bytes the solver held while solving. */
  memoryBytes: number;
}

/** Solves a heads-up river spot. Production-ready. */
export function solveRiver(spot: RiverSpot, options: SolveOptions = {}): SolveResult {
  return solveBuilt(buildRiverGame(spot), options);
}

/**
 * Solves a heads-up turn spot through the river. Correct but ~48x the river's
 * cost; see `subgame.ts` before putting it on a user-facing path.
 */
export function solveTurn(spot: TurnSpot, options: SolveOptions = {}): SolveResult {
  return solveBuilt(buildTurnGame(spot), options);
}

/** Runs the engine on a built subgame and extracts the result. */
export function solveBuilt(built: BuiltSubgame, options: SolveOptions = {}): SolveResult {
  const solver = new Solver(built.game, options.dcfr);
  const run = solver.run(options);
  return extract(built, solver, run);
}

function extract(built: BuiltSubgame, solver: Solver, run: RunResult): SolveResult {
  const { game } = built;
  const tree = game.tree;
  const evaluated = solver.evaluate();
  const ev = solver.ev as Float32Array;
  const nodes: SolvedNode[] = [];
  const n = [game.hands[0].size, game.hands[1].size];

  // Pre-order walk with both players' own reach, for range frequencies.
  const visit = (
    node: number,
    parent: number,
    parentEdge: number,
    reach: [Float64Array, Float64Array],
  ): number => {
    const type = tree.type[node];
    if (type !== ACTION && type !== CHANCE) {
      return -1;
    }
    const index = nodes.length;
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    const labels = tree.edgeLabel.slice(start, start + count);
    if (type === CHANCE) {
      const entry: SolvedNode = {
        kind: "chance",
        player: -1,
        street: "river",
        path: built.chancePath.get(node) ?? "",
        parent,
        parentEdge,
        pot: 0,
        toCall: 0,
        behind: 0,
        labels,
        actions: [],
        children: [],
        strategy: new Float32Array(0),
        ev: new Float32Array(0),
        frequency: [],
      };
      nodes.push(entry);
      for (let e = 0; e < count; e += 1) {
        const card = tree.edgeCard[start + e];
        const masked = [0, 1].map((p) => {
          const out = Float64Array.from(reach[p]);
          const hands = game.hands[p];
          for (let i = 0; i < hands.size; i += 1) {
            if (hands.c1[i] === card || hands.c2[i] === card) {
              out[i] = 0;
            }
          }
          return out;
        }) as [Float64Array, Float64Array];
        entry.children.push(visit(tree.children[start + e], index, e, masked));
      }
      return index;
    }

    const player = tree.player[node];
    const size = n[player];
    const strategy = solver.averageStrategy(node);
    const off = solver.offset[node];
    const info = built.info[node];
    const own = reach[player];
    let total = 0;
    for (let i = 0; i < size; i += 1) {
      total += own[i];
    }
    const frequency: number[] = [];
    for (let a = 0; a < count; a += 1) {
      let f = 0;
      for (let i = 0; i < size; i += 1) {
        f += own[i] * strategy[a * size + i];
      }
      frequency.push(total > 0 ? f / total : 0);
    }
    const entry: SolvedNode = {
      kind: "action",
      player,
      street: info?.street ?? built.street,
      path: info?.path ?? "",
      parent,
      parentEdge,
      pot: info?.pot ?? 0,
      toCall: info?.toCall ?? 0,
      behind: info?.behind ?? 0,
      labels,
      actions: info?.actions ?? [],
      children: [],
      strategy,
      ev: ev.slice(off, off + count * size),
      frequency,
    };
    nodes.push(entry);
    for (let a = 0; a < count; a += 1) {
      const next: [Float64Array, Float64Array] = [reach[0], reach[1]];
      const narrowed = new Float64Array(size);
      for (let i = 0; i < size; i += 1) {
        narrowed[i] = own[i] * strategy[a * size + i];
      }
      next[player] = narrowed;
      entry.children.push(visit(tree.children[start + a], index, a, next));
    }
    return index;
  };
  visit(tree.root, -1, -1, [Float64Array.from(game.hands[0].weight), Float64Array.from(game.hands[1].weight)]);

  return {
    version: SOLVER_VERSION,
    street: built.street,
    board: built.board.map(cardCode),
    pot: built.pot,
    stack: built.stack,
    firstToAct: built.firstToAct,
    hands: built.combos,
    weights: [Float32Array.from(game.hands[0].weight), Float32Array.from(game.hands[1].weight)],
    iterations: run.iterations,
    stoppedBy: run.stoppedBy,
    exploitability: run.exploitability.exploitability,
    exploitabilityPct: run.exploitability.percentPot,
    exploitabilityMbb: run.exploitability.mbb,
    value: evaluated.value,
    rootEv: [Float32Array.from(evaluated.rootEv[0]), Float32Array.from(evaluated.rootEv[1])],
    nodes,
    memoryBytes: solver.bytes,
  };
}

/** Index of the node at `path` (e.g. `"X-B6.5"`), or -1. */
export function nodeAt(result: SolveResult, path: string): number {
  return result.nodes.findIndex((node) => node.path === path);
}

/** Index of a combo among player `p`'s hands, or -1 (not in range, or blocked by the board). */
export function handIndex(result: SolveResult, p: 0 | 1, combo: number): number {
  return result.hands[p].indexOf(combo);
}

/**
 * Both players' ranges on arrival at a node: initial weights times each
 * player's own strategy along the path, with the hands that hold a dealt card
 * removed. This is the range narrowing the plan's §3.2 describes, for the next
 * street's solve or the study view.
 */
export function rangesAt(result: SolveResult, index: number): [Float64Array, Float64Array] {
  const chain: number[] = [];
  for (let at = index; at > 0; at = result.nodes[at].parent) {
    chain.push(at);
  }
  const reach: [Float64Array, Float64Array] = [Float64Array.from(result.weights[0]), Float64Array.from(result.weights[1])];
  for (let k = chain.length - 1; k >= 0; k -= 1) {
    const child = result.nodes[chain[k]];
    const parent = result.nodes[child.parent];
    if (parent.kind === "chance") {
      const card = parent.labels[child.parentEdge];
      for (let p = 0; p < 2; p += 1) {
        result.hands[p].forEach((combo, i) => {
          if (cardCode(comboHi(combo)) === card || cardCode(comboLo(combo)) === card) {
            reach[p][i] = 0;
          }
        });
      }
      continue;
    }
    const size = result.hands[parent.player].length;
    const own = reach[parent.player];
    for (let i = 0; i < size; i += 1) {
      own[i] *= parent.strategy[child.parentEdge * size + i];
    }
  }
  return reach;
}
