/**
 * The preflop trainer: a chart node, a hand dealt into it, the hero's answer
 * graded exactly as the analysis grades a real hand there.
 *
 * ```
 * family / seat / vs ─▶ trainerNodes ─▶ a node (weighted by √reach)
 *                                 ─▶ dealingWeights ─▶ a hand class ─▶ a combo (suits uniform)
 *                                 ─▶ the line as a hand (handText.ts) ─▶ the spot on the felt
 * answer ─▶ the same hand plus the hero's action ─▶ gradeAnswer (analyzeHand, grade.ts)
 * ```
 *
 * **Dealing weights.** A class is dealt as often as the reference holds it at
 * the node: `combos × range[class]` (how much of the class reaches the node
 * along the chart's own line), times the **card-removal factor** of the
 * players who acted before (`removalFactors`, A3's model: holding AA makes
 * an earlier open less likely, so AA reaches a 3-bet spot a little less often
 * than its chart weight). `borderline` multiplies that by how interesting the
 * class is here — how mixed the reference plays it and how close its two best
 * options are in EV — so a session spends its time where the decisions are
 * hard rather than on folding 72o.
 */

import { chartTree, handClassOf, isChartLibrary, isOpenLimpNode, type ChartAction, type ChartNode, type ChartPosition, type ChartSet } from "../charts";
import { opponentRanges, removalFactors, walkLine } from "../analysis";
import type { PhfHand } from "../phf/types";
import { comboCode, combosOfClass, HAND_CLASSES, NUM_CLASSES } from "../solver";
import { completePreflop, handUpTo, scriptHand, type HandScript, type ScriptAct } from "./handText";
import { nextSeed, pickOne, pickWeighted, seeded, type Rng } from "./rng";

/** The scenario families a session can pick, in the chart browser's vocabulary. */
export const PREFLOP_FAMILIES = ["rfi", "vs-open", "vs-3bet", "squeeze", "bvb", "vs-4bet", "vs-limp"] as const;
export type PreflopFamily = (typeof PREFLOP_FAMILIES)[number];

/** How hands are dealt: as the range holds them, or biased to the hard ones. */
export const DEAL_BIASES = ["range", "borderline"] as const;
export type DealBias = (typeof DEAL_BIASES)[number];

/** Seats in table order (the 6-max sets'; a set's own are `ChartSet.game.positions`). */
export const PREFLOP_SEATS: readonly ChartPosition[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
/** Every seat a chart set can have, 9-max's included (A2c): what a `seat` / `vs` parameter may name. */
export const ALL_PREFLOP_SEATS: readonly ChartPosition[] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];

/**
 * The set to deal from: `id` in a library (loaded by the caller), else
 * `charts` itself. A library without the set throws - the caller loads it.
 */
export function trainerSet(charts: ChartSet, id?: string | null): ChartSet {
  if (!id || id === charts.id) return charts;
  if (!isChartLibrary(charts)) throw new RangeError(`chart set ${id} is not available`);
  const set = charts.sets.get(id);
  if (!set) throw new RangeError(`chart set ${id} is not loaded`);
  return set;
}

/** A node reached less often than this (0.2% of deals) is too rare to drill at random. */
export const MIN_NODE_REACH = 0.002;
/**
 * The same floor for limped pots (`charts/4`): they are reached through the
 * limp's tremble (0.5% of hands per seat), so even the common ones - one
 * limper, then the button - sit below `MIN_NODE_REACH`. Dealt by √reach
 * like every node, they come up rarely at random and on every deal of the
 * `vs-limp` family.
 */
export const MIN_LIMP_NODE_REACH = 1e-4;
/** `borderline`: the floor every class keeps, so a pure fold is still dealt now and then. */
export const BORDERLINE_FLOOR = 0.1;
/** `borderline`: EV gap (bb) at which two options count as close. */
export const CLOSE_EV_BB = 0.5;

/** The families a node belongs to: the chart browser's categories (`chartSpots.ts`). */
export function familiesOf(node: ChartNode): PreflopFamily[] {
  // Folded to the blinds (on a straddle set: to the blinds and the straddler, its seats' last three).
  const blinds = node.seats[node.seats.length - 1] === "BB" ? 2 : 3;
  if (node.line.startsWith("f".repeat(node.seats.length - blinds))) return node.scenario === "rfi" ? ["rfi", "bvb"] : ["bvb"];
  if (isOpenLimpNode(node)) return ["vs-limp"];
  switch (node.scenario) {
    case "rfi":
      return ["rfi"];
    case "vs-open":
      return ["vs-open"];
    case "squeeze":
      return ["squeeze"];
    case "vs-3bet":
      return ["vs-3bet"];
    case "vs-4bet":
    case "vs-allin":
      return ["vs-4bet"];
    default:
      return ["bvb"];
  }
}

/**
 * The line's last raiser — the player the hero faces — or, in a pot nobody has
 * raised, its first limper; null in an unopened pot.
 */
export function lineAggressor(line: string, seats: readonly ChartPosition[] = PREFLOP_SEATS): ChartPosition | null {
  let last: ChartPosition | null = null;
  let limper: ChartPosition | null = null;
  for (const step of walkLine(line, seats).steps) {
    if (step.code === "r" || step.code === "a") last = step.position;
    else if (step.code === "c" && last === null && limper === null) limper = step.position;
  }
  return last ?? limper;
}

/**
 * The nodes a session can deal: a real choice, reached often enough, in the
 * family and at the seat asked for, and — `vs` — against that opener,
 * 3-bettor or 4-bettor (the line's last raiser).
 */
export function trainerNodes(
  charts: ChartSet,
  family: PreflopFamily | "random",
  seat: ChartPosition | null = null,
  vs: ChartPosition | null = null,
): ChartNode[] {
  const out: ChartNode[] = [];
  for (const node of charts.nodes.values()) {
    const limped = isOpenLimpNode(node);
    if (node.options.length < 2 || node.reach < (limped ? MIN_LIMP_NODE_REACH : MIN_NODE_REACH)) continue;
    if (seat && node.actor !== seat) continue;
    if (family !== "random" && !familiesOf(node).includes(family)) continue;
    if (vs && lineAggressor(node.line, node.seats) !== vs) continue;
    out.push(node);
  }
  return out.sort((a, b) => a.line.length - b.line.length || a.line.localeCompare(b.line));
}

/**
 * How interesting class `k` is at `node`, 0..2: how mixed the reference plays
 * it (`1 − max freq`) plus how close its two best options are in EV
 * (`exp(−gap / CLOSE_EV_BB)`).
 */
export function interest(node: ChartNode, k: number): number {
  let maxFreq = 0;
  let best = -Infinity;
  let second = -Infinity;
  for (let a = 0; a < node.options.length; a += 1) {
    maxFreq = Math.max(maxFreq, node.freq[a * NUM_CLASSES + k]);
    const ev = node.ev[a * NUM_CLASSES + k];
    if (ev > best) {
      second = best;
      best = ev;
    } else if (ev > second) {
      second = ev;
    }
  }
  const close = Number.isFinite(second) ? Math.exp(-(best - second) / CLOSE_EV_BB) : 0;
  return 1 - maxFreq + close;
}

/** Per class index: how often the class is dealt at `node` (unnormalised). */
export function dealingWeights(charts: ChartSet, node: ChartNode, bias: DealBias = "range"): Float64Array {
  const removal = removalFactors(opponentRanges(charts, node.line));
  const out = new Float64Array(NUM_CLASSES);
  for (let k = 0; k < NUM_CLASSES; k += 1) {
    const base = HAND_CLASSES[k].combos * node.range[k] * removal[k];
    out[k] = bias === "borderline" ? base * (BORDERLINE_FLOOR + interest(node, k)) : base;
  }
  return out;
}

export interface PreflopMenuItem {
  action: ChartAction;
  /** What the hero has in after the action, bb. */
  toBb: number;
}

export interface PreflopSpotOptions {
  family: PreflopFamily | "random";
  /** Chart set id (table and depth, A2c); the default set when absent. */
  set?: string | null;
  /** Only this seat as the hero; null for any. */
  seat?: ChartPosition | null;
  /**
   * Only against this raiser (the opener, 3-bettor or 4-bettor); null for any.
   * A narrowing the chart set cannot deal (no node there reached often
   * enough) is dropped rather than leaving the trainer empty: a study plan's
   * link still deals the family at the seat.
   */
  vs?: ChartPosition | null;
  bias?: DealBias;
}

export interface PreflopTrainerSpot {
  kind: "preflop";
  seed: number;
  /** Chart set id. */
  set: string;
  line: string;
  /** The family it was dealt as. */
  family: PreflopFamily;
  hero: ChartPosition;
  handClass: string;
  cards: [string, string];
  /** The hand up to the hero's decision. */
  script: HandScript;
  hand: PhfHand;
  menu: PreflopMenuItem[];
  potBb: number;
  toCallBb: number;
}

/** The chart's line as script actions: who did what, with the tree's sizes. */
export function lineActs(charts: ChartSet, line: string): ScriptAct[] {
  const tree = chartTree(charts);
  const { steps } = walkLine(line, charts.game.positions);
  const acts: ScriptAct[] = [];
  steps.forEach((step, k) => {
    if (step.code === "f") {
      acts.push({ position: step.position, type: "fold" });
    } else if (step.code === "k") {
      acts.push({ position: step.position, type: "check" });
    } else if (step.code === "c") {
      acts.push({ position: step.position, type: "call" });
    } else {
      const at = tree.lineIndex.get(line.slice(0, k));
      if (at === undefined) throw new RangeError(`no tree node for ${JSON.stringify(line.slice(0, k))}`);
      let to = -1;
      for (let e = tree.childStart[at]; e < tree.childStart[at] + tree.childCount[at]; e += 1) {
        if (tree.edgeCode[e] === step.code) to = tree.edgeTo[e];
      }
      if (to < 0) throw new RangeError(`no ${step.code} edge at ${JSON.stringify(line.slice(0, k))}`);
      acts.push({ position: step.position, type: "raise", to });
    }
  });
  return acts;
}

/** A menu item as the hero's script action. */
function answerAct(hero: ChartPosition, item: PreflopMenuItem, stackBb: number): ScriptAct {
  switch (item.action) {
    case "fold":
      return { position: hero, type: "fold" };
    case "check":
      return { position: hero, type: "check" };
    case "call":
      return { position: hero, type: "call" };
    case "allin":
      return { position: hero, type: "raise", to: stackBb };
    default:
      return { position: hero, type: "raise", to: item.toBb };
  }
}

/**
 * Deals one preflop spot from `seed`. Null when no node matches the options
 * (a family the chart set does not have at that seat).
 */
export function dealPreflop(library: ChartSet, options: PreflopSpotOptions, seed: number): PreflopTrainerSpot | null {
  const charts = trainerSet(library, options.set);
  const rng: Rng = seeded(seed);
  let nodes = trainerNodes(charts, options.family, options.seat ?? null, options.vs ?? null);
  if (nodes.length === 0 && options.vs) nodes = trainerNodes(charts, options.family, options.seat ?? null);
  if (nodes.length === 0) return null;
  const node = nodes[pickWeighted(nodes.map((n) => Math.sqrt(n.reach)), rng)];
  const weights = dealingWeights(charts, node, options.bias ?? "range");
  const k = pickWeighted(weights, rng);
  if (k < 0) return null;
  const combo = pickOne(combosOfClass(k), rng);
  const code = comboCode(combo);
  const cards: [string, string] = [code.slice(0, 2), code.slice(2)];
  const script: HandScript = {
    id: `TP${seed.toString(36)}`,
    hero: node.actor,
    heroCards: cards,
    seats: charts.game.positions,
    ...(charts.game.straddle ? { straddle: { ...charts.game.straddle } } : {}),
    stackBb: charts.game.stackBb,
    preflop: lineActs(charts, node.line),
  };
  const families = familiesOf(node);
  return {
    kind: "preflop",
    seed,
    set: charts.id,
    line: node.line,
    family: options.family !== "random" && families.includes(options.family) ? options.family : families[0],
    hero: node.actor,
    handClass: HAND_CLASSES[k].name,
    cards,
    script,
    hand: spotHand(script),
    menu: node.options.map((option) => ({ action: option.action, toBb: option.toBb })),
    potBb: node.potBb,
    toCallBb: Math.max(0, node.toMatchBb - node.inBb),
  };
}

/**
 * The hand with the hero's action appended and the orbit completed
 * (`completePreflop`), and the index of the hero's action.
 */
function answered(script: HandScript, act: ScriptAct): { hand: PhfHand; actionIndex: number } {
  const hand = scriptHand(completePreflop({ ...script, preflop: [...script.preflop, act] }));
  const hero = hand.players.find((player) => player.isHero);
  const decision = [...hand.actions].reverse().find(
    (action) => action.seat === hero?.seat && action.street === "preflop" && action.type !== "small-blind" && action.type !== "big-blind",
  );
  if (!decision) throw new RangeError("the answer did not parse as a hero decision");
  return { hand, actionIndex: decision.index };
}

/** The spot as the hero sees it: every seat at the table, the action up to the hero's decision. */
function spotHand(script: HandScript): PhfHand {
  const { hand, actionIndex } = answered(script, { position: script.hero, type: "fold" });
  return handUpTo(hand, actionIndex);
}

/** The spot's hand with the hero's answer appended, and the answer's action index. */
export function preflopAnswer(spot: PreflopTrainerSpot, menuIndex: number): { hand: PhfHand; actionIndex: number } {
  const item = spot.menu[menuIndex];
  if (!item) throw new RangeError(`no menu item ${menuIndex}`);
  return answered(spot.script, answerAct(spot.hero, item, spot.script.stackBb));
}

/** The class index of a spot's hand (for the chart grid). */
export function spotClass(spot: PreflopTrainerSpot): number {
  return handClassOf(spot.handClass);
}

/** A seed for the next spot. */
export function freshSeed(rng?: Rng): number {
  return nextSeed(rng);
}
