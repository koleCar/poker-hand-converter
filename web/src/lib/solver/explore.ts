/**
 * Browsing a flop library chunk, one decision at a time (the Solver library
 * tab, `/solver`): the acting player's strategy and EV per hand class and per
 * combo, the way a solver's viewer shows a spot.
 *
 * ```
 * a chunk (flopLibrary.ts) + a node index
 *   ─▶ exploreNode: the actor, the pot, the actions with their share of the range and where each leads,
 *                   and the 169 classes: reach, the reach-weighted mix and EV of each action
 *   ─▶ classCombos: one class's combos at the node, each with its own mix and EV
 *   ─▶ exploreHistory: the decisions from the root to the node, for the breadcrumb
 * ```
 *
 * A chunk holds the flop's decisions only (`nodes: "flop"`): an edge that
 * deals the turn ends the walk (`ends: "street"`), as does a fold
 * (`ends: "fold"`) and an all-in called down (no node below it). Reach is
 * the actor's own (`rangesAt`): the chart range times their own choices on
 * the way to the node, so a class's weight is how many of its combos still
 * get here. Amounts and EVs are in big blinds (the library solves in bb).
 * Cards are in the chunk's canonical suits (`header.flop`).
 *
 * Pure: no fetch, no React.
 */

import { cardCode } from "../equity";
import type { ActionKind } from "./betting";
import { comboHi, comboLo } from "./combos";
import type { FlopChunk } from "./flopLibrary";
import { classOfCombo, NUM_CLASSES } from "./handClasses";
import { rangesAt } from "./solve";

export interface ExploreAction {
  kind: ActionKind;
  /** The tree's edge label, e.g. `B1.82`. */
  label: string;
  /** Chips this action puts in, bb. */
  amount: number;
  /** Size as a fraction of the pot (`ActionInfo.sizePot`); 0 for fold, check and call. */
  sizePot: number;
  /** Share of the actor's range (by reach) that takes it. */
  frequency: number;
  /** The next decision on the flop, or -1 when the action ends it (`ends`). */
  child: number;
  /** Why there is no next decision: the hand is over, or the flop's betting is (the turn is not stored). */
  ends: "fold" | "street" | null;
}

export interface ExploreClass {
  /** Grid index, `row * 13 + col` (`handClasses.ts`). */
  index: number;
  /** Combos of the class in the actor's range (the board's cards out). */
  combos: number;
  /** Reach summed over those combos: how many of them get here. */
  weight: number;
  /** Per action, reach-weighted (unweighted when nothing of the class gets here). */
  freq: number[];
  /** Per action EV, bb, weighted the same way. */
  ev: number[];
  /** EV of the node under the strategy, bb. */
  value: number;
}

export interface ExploreNode {
  index: number;
  /** Solve player: 0 is out of position (`header.players[0]`). */
  player: 0 | 1;
  /** `header.players[player]`, e.g. `BTN`. */
  position: string;
  /** Edge labels from the root, e.g. `X-B1.82`. */
  path: string;
  pot: number;
  toCall: number;
  actions: ExploreAction[];
  /** All 169 grid classes, in grid order; a class outside the range has `combos: 0`. */
  classes: ExploreClass[];
  /** The whole range per action: share of the reach and the reaching combos taking it. */
  totals: Array<{ share: number; combos: number }>;
  /** Combos of the actor's range that get here (reach summed). */
  reach: number;
  /** The actor's EV over the reaching range, bb. */
  value: number;
}

export interface ExploreCombo {
  /** Two cards, higher first, e.g. `AhKh`. */
  cards: string;
  /** Reach, 0..1. */
  weight: number;
  freq: number[];
  ev: number[];
  value: number;
}

export interface ExploreStep {
  /** The decision taken. */
  node: number;
  position: string;
  action: ExploreAction;
}

/** Thrown for a node index that is not a decision of the chunk. */
export class ExploreError extends Error {}

function actionNode(chunk: FlopChunk, index: number) {
  const node = chunk.result.nodes[index];
  if (!node || node.kind !== "action") throw new ExploreError(`node ${index} is not a decision of ${chunk.header.line}/${chunk.header.flop}`);
  return node;
}

function actionsOf(chunk: FlopChunk, index: number): ExploreAction[] {
  const { nodes } = chunk.result;
  const node = actionNode(chunk, index);
  return node.actions.map((action, a) => {
    const to = node.children[a];
    const next = to >= 0 ? nodes[to] : null;
    const child = next && next.kind === "action" ? to : -1;
    return {
      kind: action.kind,
      label: node.labels[a],
      amount: action.amount,
      sizePot: action.sizePot,
      frequency: node.frequency[a] ?? 0,
      child,
      ends: child >= 0 ? null : action.kind === "fold" ? "fold" : "street",
    };
  });
}

/** The node's actions, the actor's 169 classes and the range's totals. */
export function exploreNode(chunk: FlopChunk, index: number): ExploreNode {
  const { result, header } = chunk;
  const node = actionNode(chunk, index);
  const player = node.player as 0 | 1;
  const hands = result.hands[player];
  const size = hands.length;
  const reach = rangesAt(result, index)[player];
  const actions = actionsOf(chunk, index);
  const count = actions.length;

  const combos = new Float64Array(NUM_CLASSES);
  const weight = new Float64Array(NUM_CLASSES);
  // Reach-weighted sums, and plain sums for classes that never get here.
  const freq = new Float64Array(NUM_CLASSES * count);
  const ev = new Float64Array(NUM_CLASSES * count);
  const plainFreq = new Float64Array(NUM_CLASSES * count);
  const plainEv = new Float64Array(NUM_CLASSES * count);
  const totals = new Float64Array(count);
  let all = 0;
  let value = 0;
  for (let i = 0; i < size; i += 1) {
    const k = classOfCombo(hands[i]);
    const r = reach[i];
    combos[k] += 1;
    weight[k] += r;
    all += r;
    for (let a = 0; a < count; a += 1) {
      const s = node.strategy[a * size + i];
      const e = node.ev[a * size + i];
      freq[k * count + a] += r * s;
      ev[k * count + a] += r * e;
      plainFreq[k * count + a] += s;
      plainEv[k * count + a] += e;
      totals[a] += r * s;
      value += r * s * e;
    }
  }

  const classes: ExploreClass[] = [];
  for (let k = 0; k < NUM_CLASSES; k += 1) {
    const w = weight[k];
    const n = combos[k];
    const reached = w > 0;
    const f: number[] = [];
    const e: number[] = [];
    let v = 0;
    for (let a = 0; a < count; a += 1) {
      const fa = n === 0 ? 0 : reached ? freq[k * count + a] / w : plainFreq[k * count + a] / n;
      const ea = n === 0 ? 0 : reached ? ev[k * count + a] / w : plainEv[k * count + a] / n;
      f.push(fa);
      e.push(ea);
      v += fa * ea;
    }
    classes.push({ index: k, combos: n, weight: w, freq: f, ev: e, value: v });
  }

  return {
    index,
    player,
    position: header.players[player],
    path: node.path,
    pot: node.pot,
    toCall: node.toCall,
    actions,
    classes,
    totals: Array.from(totals, (combosTaking) => ({ share: all > 0 ? combosTaking / all : 0, combos: combosTaking })),
    reach: all,
    value: all > 0 ? value / all : 0,
  };
}

/** One class's combos at the node, most reaching first. */
export function classCombos(chunk: FlopChunk, index: number, classIndex: number): ExploreCombo[] {
  const { result } = chunk;
  const node = actionNode(chunk, index);
  const player = node.player as 0 | 1;
  const hands = result.hands[player];
  const size = hands.length;
  const reach = rangesAt(result, index)[player];
  const count = node.actions.length;
  const out: ExploreCombo[] = [];
  for (let i = 0; i < size; i += 1) {
    const combo = hands[i];
    if (classOfCombo(combo) !== classIndex) continue;
    const freq: number[] = [];
    const ev: number[] = [];
    let value = 0;
    for (let a = 0; a < count; a += 1) {
      const s = node.strategy[a * size + i];
      const e = node.ev[a * size + i];
      freq.push(s);
      ev.push(e);
      value += s * e;
    }
    out.push({ cards: `${cardCode(comboHi(combo))}${cardCode(comboLo(combo))}`, weight: reach[i], freq, ev, value });
  }
  return out.sort((x, y) => y.weight - x.weight || x.cards.localeCompare(y.cards));
}

/** The decisions from the root to `index`, each with the action taken. Empty at the root. */
export function exploreHistory(chunk: FlopChunk, index: number): ExploreStep[] {
  const { nodes } = chunk.result;
  actionNode(chunk, index);
  const steps: ExploreStep[] = [];
  for (let at = index; nodes[at].parent >= 0; at = nodes[at].parent) {
    const parent = nodes[at].parent;
    const node = actionNode(chunk, parent);
    steps.push({ node: parent, position: chunk.header.players[node.player], action: actionsOf(chunk, parent)[nodes[at].parentEdge] });
  }
  return steps.reverse();
}
