/**
 * The exploit lab on a river (Learn L4, the `node-lock` exercise and the
 * lab widget): a river Rail solves in the browser, one opponent tendency
 * locked, and the hero's best response against it.
 *
 * ```
 * a river spot, the hero in position (river.ts: a chart line, a board, the analysis' narrowing and solve)
 *   ─▶ the same game rebuilt and loaded with the solve (`riverSpotOf`, `loadResult`)
 *   ─▶ a lock on the opponent, who acts first (`LAB_LOCKS`):
 *        fold-to-bet   checked to, the hero bets: the opponent folds this many points more (or fewer)
 *                      than the baseline does, at every bet size
 *        never-raise   the same nodes: the opponent never raises
 *        air-bets      first to act: the opponent bets this share of its air (no pair, ace-high, missed draws)
 *   ─▶ exploitLab (lib/solver/lock.ts): the hero's best response, what it gains over the
 *      baseline against this opponent, and what it gives back if the read is wrong
 *   ─▶ the hero decisions the response changes most, by hand category, baseline against response
 *   ─▶ a question: one hand where the response's best action is not what the baseline plays most
 * answer ─▶ right when its EV against the locked opponent is within `LAB_TOLERANCE` of the best
 * ```
 *
 * **One grader.** The answer is the solver's: the best response's own EV per
 * action for the hand, computed by the same engine that grades the
 * analysis' rivers. The item carries those numbers, so the screen grades
 * without asking the worker again (like the range split).
 *
 * The ranges are the analysis' ranges (the charts narrowed by the heuristic
 * model), with every caveat that carries; and a lock is a read, not a fact —
 * the screen says both.
 *
 * Pure and deterministic in its seed.
 */

import type { ChartPosition, ChartSet } from "../charts";
import { RIVER_CATEGORIES, riverCategory, riverSpotOf } from "../analysis";
import { cardCode } from "../equity/evaluator";
import {
  buildRiverGame,
  comboHi,
  comboLo,
  exploitLab,
  groupShareOf,
  loadResult,
  ownReach,
  rangesAt,
  Solver,
  type ActionKind,
  type LabResult,
  type NodeLock,
  type SolveResult,
} from "../solver";
import { isShift, LAB_PRESET_IDS, LAB_PRESETS, validValue, type LabLock, type LabPreset } from "./labPresets";
import { MAX_ATTEMPTS, riverSetup, type RiverPot, type RiverSetup } from "./river";
import { pickOne, pickWeighted, seeded, type Rng } from "./rng";

export { isLabPreset, isShift, LAB_LOCKS, LAB_PRESET_IDS, LAB_PRESETS, validValue, type LabLock, type LabPreset } from "./labPresets";

/** An answer is right within this share of the pot (in EV against the locked opponent) of the best action. */
export const LAB_TOLERANCE = 0.01;
/** A question needs the best action ahead of the baseline's favourite by at least this share of the pot. */
export const LAB_CLEAR = 0.02;
/** The response keeps the baseline's mix in a hand within this share of the river pot of its best action. */
export const LAB_KEEP = 0.005;
/** River categories the `air-bets` lock is about: hands that win no showdown against a bet. */
export const AIR_CATEGORIES: ReadonlySet<string> = new Set(["no-pair", "ace-high", "missed-flush-draw", "missed-straight-draw"]);
/** A hero decision is shown when its change is at least this share of the most changed one. */
const SECOND_VIEW = 0.3;
/** Categories with less of the range than this (in both worlds) are left out of a view. */
const MIN_ROW_SHARE = 0.03;

export interface LabOptions {
  preset: LabPreset | "any";
  /** The learner's own value for the preset's lock (the widget, `validValue`); the preset's when absent. */
  value?: number;
  pot?: RiverPot | "any";
}

export interface LabStep {
  who: "hero" | "villain";
  kind: ActionKind;
  sizePot: number;
}

/** One locked decision of the opponent. */
export interface LabLockView {
  /** The river actions before it. */
  steps: LabStep[];
  /** The group's share at the baseline, and as locked. */
  equilibrium: number;
  locked: number;
}

export interface LabRow {
  /** `riverCategory`. */
  key: string;
  /** Weighted combos of the hero's range at the node, playing the response. */
  combos: number;
  /** Per action: the baseline's mix, and the response's. */
  eq: number[];
  best: number[];
}

/** One hero decision, baseline against response. */
export interface LabView {
  steps: LabStep[];
  potBb: number;
  toCallBb: number;
  actions: Array<{ kind: ActionKind; sizePot: number }>;
  overall: { eq: number[]; best: number[] };
  rows: LabRow[];
}

export interface LabQuestion {
  /** Index into `views`. */
  view: number;
  cards: [string, string];
  category: string;
  /** Per action: EV against the locked opponent (bb, from the start of the river, the pot counted). */
  ev: number[];
  /** The actions within `LAB_TOLERANCE` of the best. */
  right: number[];
  /** The hand's mix at the baseline, and in the response. */
  eq: number[];
  best: number[];
}

export interface LabItem {
  kind: "lab";
  seed: number;
  preset: LabPreset;
  lock: LabLock;
  /** The lock's value: a shift (`fold-to-bet`) or a share. */
  value: number;
  lineId: string;
  pot: RiverPot;
  hero: ChartPosition;
  villain: ChartPosition;
  board: string[];
  /** Pot and effective stack at the start of the river, bb. */
  potBb: number;
  stackBb: number;
  locks: LabLockView[];
  /** The hero's, in bb per river played from these ranges (`LabResult`). */
  numbers: { equilibrium: number; gain: number; riskVsEquilibrium: number; riskVsCounter: number; baselineRisk: number };
  views: LabView[];
  question: LabQuestion;
  iterations: number;
  exploitabilityPct: number;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const sum = (xs: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) s += xs[i];
  return s;
};

/** The river actions on the way to a result node. */
function stepsTo(result: SolveResult, index: number, hero: 0 | 1): LabStep[] {
  const out: LabStep[] = [];
  for (let at = index; at > 0; at = result.nodes[at].parent) {
    const node = result.nodes[at];
    const parent = result.nodes[node.parent];
    const action = parent.actions[node.parentEdge];
    out.push({ who: parent.player === hero ? "hero" : "villain", kind: action.kind, sizePot: round(action.sizePot, 3) });
  }
  return out.reverse();
}

/** A copy of a result with some nodes' strategies replaced (by result index): another world for `rangesAt`. */
function withStrategies(result: SolveResult, rows: ReadonlyMap<number, Float32Array>): SolveResult {
  return { ...result, nodes: result.nodes.map((node, k) => (rows.has(k) ? { ...node, strategy: rows.get(k) as Float32Array } : node)) };
}

/** The locks a preset puts on a solved river, as tree nodes. Empty when the spot has nowhere to put them. */
function locksFor(
  lock: LabLock,
  value: number,
  result: SolveResult,
  ids: Int32Array,
  villain: 0 | 1,
  order: ArrayLike<number>,
  board: readonly number[],
): Array<NodeLock & { index: number }> {
  const root = result.nodes[0];
  if (root.player !== villain) return [];
  if (lock === "air-bets") {
    const check = root.actions.findIndex((a) => a.kind === "check");
    const group = root.actions.flatMap((a, k) => (a.kind === "check" ? [] : [k]));
    if (check < 0 || group.length === 0) return [];
    const mask = Array.from(result.hands[villain], (combo) => (AIR_CATEGORIES.has(riverCategory([comboHi(combo), comboLo(combo)], board)) ? 1 : 0));
    if (!mask.some(Boolean)) return [];
    return [{ index: 0, node: ids[0], group, share: value, order, mask, fallback: check }];
  }
  const check = root.actions.findIndex((a) => a.kind === "check");
  if (check < 0 || root.children[check] < 0) return [];
  const heroIndex = root.children[check];
  const heroNode = result.nodes[heroIndex];
  const out: Array<NodeLock & { index: number }> = [];
  heroNode.actions.forEach((action, a) => {
    if (action.kind !== "bet" && action.kind !== "allin") return;
    const index = heroNode.children[a];
    if (index < 0) return;
    const node = result.nodes[index];
    const fold = node.actions.findIndex((x) => x.kind === "fold");
    const call = node.actions.findIndex((x) => x.kind === "call");
    if (fold < 0 || call < 0) return;
    const group = lock === "fold-to-bet" ? [fold] : node.actions.flatMap((x, k) => (x.kind === "raise" || x.kind === "allin" ? [k] : []));
    if (group.length === 0) return;
    out.push({ index, node: ids[index], group, share: value, order, fallback: call });
  });
  return out;
}

/** The hero's range at a node by category, in the baseline and in the response. */
export function viewAt(eqWorld: SolveResult, bestWorld: SolveResult, index: number, hero: 0 | 1, board: readonly number[]): LabView {
  const node = eqWorld.nodes[index];
  const n = eqWorld.hands[hero].length;
  const count = node.actions.length;
  const eqReach = rangesAt(eqWorld, index)[hero];
  const bestReach = rangesAt(bestWorld, index)[hero];
  const eqStrategy = node.strategy;
  const bestStrategy = bestWorld.nodes[index].strategy;
  const rows = new Map<string, { eqW: number; bestW: number; eq: number[]; best: number[] }>();
  const overall = { eqW: 0, bestW: 0, eq: new Array(count).fill(0), best: new Array(count).fill(0) };
  for (let i = 0; i < n; i += 1) {
    const we = eqReach[i] > 0 ? eqReach[i] : 0;
    const wb = bestReach[i] > 0 ? bestReach[i] : 0;
    if (!(we > 0) && !(wb > 0)) continue;
    const combo = eqWorld.hands[hero][i];
    const key = riverCategory([comboHi(combo), comboLo(combo)], board);
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { eqW: 0, bestW: 0, eq: new Array(count).fill(0), best: new Array(count).fill(0) }));
    row.eqW += we;
    row.bestW += wb;
    overall.eqW += we;
    overall.bestW += wb;
    for (let a = 0; a < count; a += 1) {
      row.eq[a] += we * eqStrategy[a * n + i];
      row.best[a] += wb * bestStrategy[a * n + i];
      overall.eq[a] += we * eqStrategy[a * n + i];
      overall.best[a] += wb * bestStrategy[a * n + i];
    }
  }
  const mix = (xs: number[], w: number) => xs.map((x) => (w > 0 ? round(x / w, 4) : 0));
  const order = RIVER_CATEGORIES.map((c) => c.key as string);
  return {
    steps: stepsTo(eqWorld, index, hero),
    potBb: round(node.pot, 2),
    toCallBb: round(node.toCall, 2),
    actions: node.actions.map((action) => ({ kind: action.kind, sizePot: round(action.sizePot, 3) })),
    overall: { eq: mix(overall.eq, overall.eqW), best: mix(overall.best, overall.bestW) },
    rows: [...rows.entries()]
      .filter(([, row]) => row.eqW / (overall.eqW || 1) >= MIN_ROW_SHARE || row.bestW / (overall.bestW || 1) >= MIN_ROW_SHARE)
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([key, row]) => ({ key, combos: round(row.bestW > 0 ? row.bestW : row.eqW, 2), eq: mix(row.eq, row.eqW), best: mix(row.best, row.bestW) })),
  };
}

/** A river with a lock and the response: the two worlds a lab item, and the direction check, read. */
export interface LabWorlds {
  result: SolveResult;
  /** The locked opponent and the responding hero, as a result (for `rangesAt` and the views). */
  bestWorld: SolveResult;
  lab: LabResult;
  /** Tree node id of each result node. */
  ids: Int32Array;
  hero: 0 | 1;
  villain: 0 | 1;
  board: number[];
  locks: LabLockView[];
}

/** Locks a solved river and best-responds. Null when the lock has nowhere to act. */
export function labWorlds(setup: RiverSetup, lock: LabLock, value: number): LabWorlds | null {
  const { solve } = setup;
  const result = solve.result;
  const hero = solve.hero;
  const villain = (1 - hero) as 0 | 1;
  const board = [...solve.input.board];
  const built = buildRiverGame(riverSpotOf(solve.input).spot);
  const solver = new Solver(built.game);
  let ids: Int32Array;
  try {
    ids = loadResult(solver, result);
  } catch {
    return null;
  }
  // Weakest first: a player who folds more folds his worst hands first; one who bluffs more bluffs his worst.
  const order = built.game.boards[0].order[villain];
  // A lock where the opponent never arrives (it never checks, or holds no air) locks nothing.
  const reach = ownReach(solver, villain);
  const locks = locksFor(lock, value, result, ids, villain, order, board).filter((l) => {
    const r = reach.get(l.node);
    let w = 0;
    if (r) for (let i = 0; i < r.length; i += 1) w += l.mask && !l.mask[i] ? 0 : r[i];
    return w > 1e-9;
  });
  if (locks.length === 0) return null;
  if (isShift(lock)) {
    // A shift: each node's share is the baseline's there plus the value.
    for (const l of locks) {
      const n = built.game.hands[villain].size;
      const base = groupShareOf(solver.averageStrategy(l.node), built.game.tree.childCount[l.node], n, reach.get(l.node) as Float64Array, l.group, l.mask);
      l.share = Math.min(1, Math.max(0, base + value));
    }
  }

  const lab = exploitLab(solver, hero, locks, { keep: LAB_KEEP * result.pot });
  const locksView: LabLockView[] = locks.map((l) => {
    const row = lab.locked.get(l.node);
    const count = built.game.tree.childCount[l.node];
    const n = built.game.hands[villain].size;
    const r = reach.get(l.node) as Float64Array;
    return {
      steps: stepsTo(result, l.index, hero),
      equilibrium: round(groupShareOf(row?.equilibrium ?? [], count, n, r, l.group, l.mask), 4),
      locked: round(groupShareOf(row?.strategy ?? [], count, n, r, l.group, l.mask), 4),
    };
  });

  // The locked world: the opponent locked, the hero responding (by result index).
  const indexOf = new Map<number, number>();
  ids.forEach((node, k) => indexOf.set(node, k));
  const overrides = new Map<number, Float32Array>();
  for (const [node, row] of lab.locked) overrides.set(indexOf.get(node) as number, row.strategy);
  for (const [node, row] of lab.response) overrides.set(indexOf.get(node) as number, row.strategy);
  return { result, bestWorld: withStrategies(result, overrides), lab, ids, hero, villain, board, locks: locksView };
}

/** The lab on one solved river. Null when the lock has nothing to act on or no hand makes a question. */
export function labOn(setup: RiverSetup, preset: LabPreset, value: number, rng: Rng, seed: number): LabItem | null {
  const lock = LAB_PRESETS[preset].lock;
  const worlds = labWorlds(setup, lock, value);
  if (!worlds) return null;
  const { result, bestWorld, lab, ids, hero, villain, board, locks: locksView } = worlds;

  // The hero decisions the response changes most: how often the hero gets there, times how much changes.
  const heroTotal = sum(result.weights[hero]);
  const villainTotal = sum(result.weights[villain]);
  const scored: Array<{ index: number; score: number }> = [];
  result.nodes.forEach((node, k) => {
    if (node.kind !== "action" || node.player !== hero) return;
    const row = lab.response.get(ids[k]);
    if (!row) return;
    const ranges = rangesAt(bestWorld, k);
    const heroReach = ranges[hero];
    const mass = (sum(heroReach) / heroTotal) * (sum(ranges[villain]) / villainTotal);
    if (!(mass > 0)) return;
    const n = heroReach.length;
    let moved = 0;
    let weight = 0;
    for (let i = 0; i < n; i += 1) {
      const w = heroReach[i];
      if (!(w > 0)) continue;
      let tv = 0;
      for (let a = 0; a < node.actions.length; a += 1) tv += Math.abs(row.strategy[a * n + i] - node.strategy[a * n + i]);
      moved += (w * tv) / 2;
      weight += w;
    }
    if (weight > 0) scored.push({ index: k, score: (mass * moved) / weight });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length === 0 || !(scored[0].score > 1e-6)) return null;

  // A question: a hand where the response's best action is not the baseline's favourite, clearly.
  let question: LabQuestion | null = null;
  let questionAt = -1;
  for (const { index } of scored.slice(0, 4)) {
    const node = result.nodes[index];
    const row = lab.response.get(ids[index]) as { strategy: Float32Array; ev: Float32Array };
    const n = result.hands[hero].length;
    const count = node.actions.length;
    const reachBest = rangesAt(bestWorld, index)[hero];
    const tolerance = LAB_TOLERANCE * node.pot;
    const weights = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      if (!(reachBest[i] > 0)) continue;
      let max = -Infinity;
      for (let a = 0; a < count; a += 1) max = Math.max(max, row.ev[a * n + i]);
      let eqTop = 0;
      for (let a = 1; a < count; a += 1) if (node.strategy[a * n + i] > node.strategy[eqTop * n + i]) eqTop = a;
      if (max - row.ev[eqTop * n + i] < LAB_CLEAR * node.pot) continue;
      if (row.ev[eqTop * n + i] >= max - tolerance) continue;
      weights[i] = reachBest[i];
    }
    const i = pickWeighted(weights, rng);
    if (i < 0) continue;
    const combo = result.hands[hero][i];
    // Rounded as shown, and graded on what is shown.
    const ev = Array.from({ length: count }, (_, a) => round(row.ev[a * n + i], 3));
    const max = Math.max(...ev);
    const shownTolerance = LAB_TOLERANCE * round(node.pot, 2);
    question = {
      view: 0,
      cards: [cardCode(comboHi(combo)), cardCode(comboLo(combo))],
      category: riverCategory([comboHi(combo), comboLo(combo)], board),
      ev,
      right: Array.from({ length: count }, (_, a) => a).filter((a) => ev[a] >= max - shownTolerance - 1e-9),
      eq: Array.from({ length: count }, (_, a) => round(node.strategy[a * n + i], 4)),
      best: Array.from({ length: count }, (_, a) => round(row.strategy[a * n + i], 4)),
    };
    questionAt = index;
    break;
  }
  if (!question) return null;

  // The question's decision first, then the most changed other one when it changes nearly as much.
  const shown = [questionAt];
  const other = scored.find((s) => s.index !== questionAt);
  if (other && other.score >= SECOND_VIEW * scored[0].score) shown.push(other.index);
  const views = shown.map((index) => viewAt(result, bestWorld, index, hero, board));

  const money = (x: number) => round(x, 3);
  return {
    kind: "lab",
    seed,
    preset,
    lock,
    value,
    lineId: setup.line.id,
    pot: setup.line.pot,
    hero: setup.hero,
    villain: setup.villain,
    board: setup.board,
    potBb: round(setup.potBb, 2),
    stackBb: round(setup.stack, 2),
    locks: locksView,
    numbers: {
      equilibrium: money(lab.equilibrium),
      gain: money(lab.gain),
      riskVsEquilibrium: money(lab.riskVsEquilibrium),
      riskVsCounter: money(lab.riskVsCounter),
      baselineRisk: money(lab.baselineRisk),
    },
    views,
    question,
    iterations: result.iterations,
    exploitabilityPct: round(result.exploitabilityPct, 3),
  };
}

/**
 * A lab item for `seed`: a river where the hero is in position, the preset's
 * lock (or `options.value`), the response and a question. Deterministic.
 * Null when no attempt found a spot the lock changes (rare).
 */
export function generateLab(charts: ChartSet, options: LabOptions, seed: number): LabItem | null {
  const rng = seeded(seed);
  for (let tries = 0; tries < MAX_ATTEMPTS; tries += 1) {
    const preset = options.preset === "any" ? pickOne(LAB_PRESET_IDS, rng) : options.preset;
    const lock = LAB_PRESETS[preset].lock;
    const value = options.value !== undefined && validValue(lock, options.value) ? options.value : LAB_PRESETS[preset].value;
    const setup = riverSetup(charts, { pot: options.pot ?? "any", seat: "ip" }, rng, seed);
    if (!setup) continue;
    const item = labOn(setup, preset, value, rng, seed);
    if (item) return item;
  }
  return null;
}

/** Grades an answer to the item's question: right when it is one of the response's best actions. */
export function gradeLab(item: LabItem, actionIndex: number): { correct: boolean } {
  return { correct: item.question.right.includes(actionIndex) };
}
