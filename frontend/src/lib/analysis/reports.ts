/**
 * Reports: your frequencies against the reference's (`docs/ANALYSIS-PLAN.md`
 * §0.1 *Reports*, §2 on mixed strategies, §6.3, phase A3).
 *
 * The database counts (`analysis_node_actions`): how often the player took
 * each action at each chart node, and with which hand classes. Everything
 * here is the chart side of the comparison, pure and deterministic:
 *
 * - **The range reference** at a node: how often a player who follows the
 *   charts takes each action when it is at this node, i.e. the chart's
 *   frequencies averaged over the whole range that reaches the node,
 *   combo-weighted — `Σ combos(c)·range(c)·r(c)·freq(a,c) / Σ combos(c)·range(c)·r(c)`.
 *   `r(c)` is the **card-removal approximation**: the opponents who acted
 *   before the node (folds included) did so with the chart's ranges, and
 *   holding class `c` changes how likely those ranges are. Per opponent,
 *   `r = Σ_d compat(c,d)·w(d) / Σ_d combos(d)·w(d)`, with `w` the opponent's
 *   range times the frequency of the action it took, and `compat(c,d)` the
 *   combos of `d` left by one combo of `c` (exact). Opponents are taken as
 *   independent of each other given the actor — the charts' own model
 *   (`docs/CHARTS.md` §2) — and a player whose fold was forced (no node) or
 *   whose line left the chart set carries no information. `cardRemoval: false`
 *   gives the plain combo-weighted average, the chart browser's "whole range".
 * - **The hand-adjusted reference**: the chart's frequency for the hand
 *   classes the player actually held there, averaged over their decisions —
 *   `Σ_i freq(a, class_i) / n`. A player's sample at a node is their own
 *   hands, which are not drawn from the reference's range (they reach a
 *   3-bet with *their* opening range) and, at small sizes, not even
 *   representative of it. Against the range reference a perfect player with
 *   twelve hands still "deviates" by the luck of the deal; against the
 *   hand-adjusted one they match exactly whenever the chart is pure. The
 *   range reference answers "is my frequency the reference's", the adjusted
 *   one "did I play the hands I had the way the reference would".
 * - **Uncertainty**: a 95% Wilson interval on the player's frequency (the
 *   statistics screen's choice, `components/stats/uncertainty.ts`, for the
 *   same reasons; this is the same formula in fractions). A player who plays
 *   the reference's strategy on hands dealt from the reference's range takes
 *   an action `Binomial(n, p_ref)` times, so a range reference outside the
 *   interval is a deviation the sample can see.
 * - **Familiar stats** (RFI, blind defence, 3-bet, fold to 3-bet, 4-bet,
 *   squeeze, steal, fold to steal) are sums of nodes. Each node's reference
 *   is weighted by **the player's own decisions at that node**, so the
 *   reference for "RFI overall" is the chart's RFI for the mix of positions
 *   the player actually opened from, not the chart's average over all seats.
 *
 * Same import rule as the rest of `lib/analysis`: only `lib/charts`' public
 * index and `lib/equity`. The words live in `ns/analysis.*.ts`.
 */

import { handClassOf, type ChartAction, type ChartNode, type ChartPosition, type ChartSet } from "../charts";
import { allClasses, classCombos } from "../equity/range";

/** Chart actions in a fixed order: the order every report lists them in. */
export const CHART_ACTIONS: readonly ChartAction[] = ["fold", "check", "call", "raise", "allin"];
export type ActionFreq = Record<ChartAction, number>;

/**
 * Table order, as the 6-max sets' line keys are written (`docs/CHARTS.md` §6).
 * Reports read the library's own fields, the 6-max 100bb set (A2c).
 */
export const TABLE_ORDER: readonly ChartPosition[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
/** Postflop order: lower acts first. The later of two players is in position. */
export const POSTFLOP_ORDER: Readonly<Record<ChartPosition, number>> = {
  SB: 0,
  BB: 1,
  UTG: 2,
  "UTG+1": 3,
  "UTG+2": 4,
  LJ: 5,
  HJ: 6,
  CO: 7,
  BTN: 8,
};

/** Below this many decisions a comparison is "too few to say", whatever the interval. */
export const MIN_SAMPLE = 10;
/**
 * A gap smaller than this (2 percentage points) is never called a deviation,
 * however large the sample: at that size it is inside the charts' own
 * modelling error (`docs/CHARTS.md` §9), not a leak.
 */
export const MIN_PRACTICAL_DIFF = 0.02;
/** The two-sided 95% normal quantile, as `uncertainty.ts` uses. */
export const WILSON_Z = 1.959964;

const NUM_CLASSES = 169;
const CLASS_NAMES: readonly string[] = allClasses();

const emptyFreq = (): ActionFreq => ({ fold: 0, check: 0, call: 0, raise: 0, allin: 0 });

/** `<set>:<line>` — the key a node is counted under (the UTG open's line is empty). */
export const nodeKey = (set: string, line: string) => `${set}:${line}`;

/* ------------------------------------------------------------- the line - */

export interface LineStep {
  position: ChartPosition;
  /** `f`, `k`, `c`, `r` or `a`. */
  code: string;
}

/**
 * Who took each action of a line key, and who acts next. A line has one
 * letter per action in turn order, folds included, so the actor of a letter
 * is the next player who has neither folded nor gone all in.
 */
export function walkLine(line: string): { steps: LineStep[]; next: ChartPosition | null } {
  const folded = new Set<number>();
  const allIn = new Set<number>();
  const steps: LineStep[] = [];
  let seat = -1;
  const advance = (): number | null => {
    for (let tries = 0; tries < TABLE_ORDER.length; tries += 1) {
      seat = (seat + 1) % TABLE_ORDER.length;
      if (!folded.has(seat) && !allIn.has(seat)) return seat;
    }
    return null;
  };
  let facingAllIn = false;
  for (const code of line) {
    const at = advance();
    if (at === null) return { steps, next: null };
    steps.push({ position: TABLE_ORDER[at], code });
    if (code === "f") folded.add(at);
    else if (code === "a") {
      facingAllIn = true;
      allIn.add(at);
    } else if (code === "c" && facingAllIn) allIn.add(at);
  }
  const at = advance();
  return { steps, next: at === null ? null : TABLE_ORDER[at] };
}

/** The player who opened (the first raise of the line), or null. */
export function openerOf(line: string): ChartPosition | null {
  const first = walkLine(line).steps.find((step) => step.code === "r" || step.code === "a");
  return first ? first.position : null;
}

/* ------------------------------------------------------- card removal - */

let compatCache: Float64Array | null = null;
let combosCache: Float64Array | null = null;

/** Combos per class index (6 / 4 / 12), before card removal. */
function classComboCounts(): Float64Array {
  if (!combosCache) {
    combosCache = new Float64Array(NUM_CLASSES);
    for (const name of CLASS_NAMES) combosCache[handClassOf(name)] = classCombos(name).length;
  }
  return combosCache;
}

/**
 * `compat[i * 169 + j]`: combos of class `j` that share no card with one
 * combo of class `i`. Exact (every combo of a class leaves the same count, by
 * suit symmetry), so one representative combo per class is enough.
 */
export function compatibility(): Float64Array {
  if (compatCache) return compatCache;
  const out = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  const combos = CLASS_NAMES.map((name) => ({ index: handClassOf(name), combos: classCombos(name) }));
  for (const a of combos) {
    const [x, y] = a.combos[0];
    for (const b of combos) {
      let n = 0;
      for (const [p, q] of b.combos) if (p !== x && p !== y && q !== x && q !== y) n += 1;
      out[a.index * NUM_CLASSES + b.index] = n;
    }
  }
  compatCache = out;
  return out;
}

export interface OpponentRange {
  position: ChartPosition;
  /** Per class index: how much of each class the opponent holds after its last action. */
  weights: Float64Array;
  /** The node and option it was read at. */
  line: string;
  code: string;
}

/**
 * The ranges of the players who acted before `line`'s next actor, as the
 * charts play them: at each player's last node on the line, `range × freq`
 * of the action it took. Forced folds (no node) and actions at nodes the set
 * does not hold are left out — they carry no information the charts have.
 */
export function opponentRanges(charts: ChartSet, line: string): OpponentRange[] {
  const { steps, next } = walkLine(line);
  const last = new Map<ChartPosition, { node: ChartNode; option: number; code: string }>();
  for (let k = 0; k < steps.length; k += 1) {
    const node = charts.nodes.get(line.slice(0, k));
    if (!node || node.actor !== steps[k].position) continue;
    const option = node.options.findIndex((o) => o.code === steps[k].code);
    if (option < 0) continue;
    last.set(steps[k].position, { node, option, code: steps[k].code });
  }
  const out: OpponentRange[] = [];
  for (const [position, { node, option, code }] of last) {
    if (position === next) continue;
    const weights = new Float64Array(NUM_CLASSES);
    for (let c = 0; c < NUM_CLASSES; c += 1) weights[c] = node.range[c] * node.freq[option * NUM_CLASSES + c];
    out.push({ position, weights, line: node.line, code });
  }
  return out.sort((a, b) => TABLE_ORDER.indexOf(a.position) - TABLE_ORDER.indexOf(b.position));
}

/**
 * Per class of the actor, the relative likelihood of the opponents' line
 * (1 = no effect). The product over opponents of `Σ_d compat(c,d)·w(d) /
 * Σ_d combos(d)·w(d)`; classes whose likelihood the opponents' ranges make
 * zero come out zero.
 */
export function removalFactors(opponents: readonly OpponentRange[]): Float64Array {
  const compat = compatibility();
  const combos = classComboCounts();
  const out = new Float64Array(NUM_CLASSES).fill(1);
  for (const opponent of opponents) {
    let base = 0;
    for (let d = 0; d < NUM_CLASSES; d += 1) base += combos[d] * opponent.weights[d];
    if (base <= 0) continue;
    // Normalise to the deck after one known combo (1225 of 1326 combos).
    const scale = 1326 / 1225 / base;
    for (let c = 0; c < NUM_CLASSES; c += 1) {
      let left = 0;
      const row = c * NUM_CLASSES;
      for (let d = 0; d < NUM_CLASSES; d += 1) left += compat[row + d] * opponent.weights[d];
      out[c] *= left * scale;
    }
  }
  return out;
}

/* ---------------------------------------------------------- references - */

/** Index of each chart action among a node's options, -1 when the node does not offer it. */
function optionIndex(node: ChartNode): Record<ChartAction, number> {
  const out = { fold: -1, check: -1, call: -1, raise: -1, allin: -1 } as Record<ChartAction, number>;
  node.options.forEach((option, index) => {
    out[option.action] = index;
  });
  return out;
}

export interface RangeReference {
  /** Per action, 0–1; sums to 1 over the node's options. Actions the node lacks are 0. */
  freq: ActionFreq;
  /** Combos in the range, before card removal: Σ combos(c)·range(c). */
  combos: number;
}

const rangeCache = new WeakMap<ChartNode, Map<string, RangeReference>>();

/**
 * The whole range's frequencies at a node (see the header). Cached per node
 * and option set, so a report over every node pays for each once.
 */
export function rangeReference(charts: ChartSet, node: ChartNode, options: { cardRemoval?: boolean } = {}): RangeReference {
  const removal = options.cardRemoval ?? true;
  const key = removal ? "removal" : "plain";
  let byKey = rangeCache.get(node);
  const cached = byKey?.get(key);
  if (cached) return cached;
  const combos = classComboCounts();
  const factors = removal ? removalFactors(opponentRanges(charts, node.line)) : null;
  const index = optionIndex(node);
  const freq = emptyFreq();
  let total = 0;
  let plain = 0;
  for (let c = 0; c < NUM_CLASSES; c += 1) {
    const reach = combos[c] * node.range[c];
    plain += reach;
    const weight = reach * (factors ? factors[c] : 1);
    if (weight <= 0) continue;
    total += weight;
    for (const action of CHART_ACTIONS) {
      if (index[action] >= 0) freq[action] += weight * node.freq[index[action] * NUM_CLASSES + c];
    }
  }
  if (total > 0) for (const action of CHART_ACTIONS) freq[action] /= total;
  const result: RangeReference = { freq, combos: plain };
  if (!byKey) {
    byKey = new Map();
    rangeCache.set(node, byKey);
  }
  byKey.set(key, result);
  return result;
}

/**
 * The chart's frequencies for the hands the player held at a node: per class
 * name, how many decisions; the mean of the chart's per-class frequencies,
 * weighted by those counts. Null when no class is readable.
 */
export function handAdjustedReference(node: ChartNode, counts: ReadonlyMap<string, number>): ActionFreq | null {
  const index = optionIndex(node);
  const freq = emptyFreq();
  let total = 0;
  for (const [name, n] of counts) {
    const c = handClassOf(name);
    if (c < 0 || !(n > 0)) continue;
    total += n;
    for (const action of CHART_ACTIONS) {
      if (index[action] >= 0) freq[action] += n * node.freq[index[action] * NUM_CLASSES + c];
    }
  }
  if (total === 0) return null;
  for (const action of CHART_ACTIONS) freq[action] /= total;
  return freq;
}

/* --------------------------------------------------------- uncertainty - */

/** The 95% Wilson score interval for `made` of `n`, as fractions. Null for an empty sample. */
export function wilsonInterval(made: number, n: number, z = WILSON_Z): { low: number; high: number } | null {
  if (!Number.isFinite(made) || !Number.isFinite(n) || n <= 0) return null;
  const p = Math.min(Math.max(made / n, 0), 1);
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - spread), high: Math.min(1, centre + spread) };
}

/**
 * - `in-line`: the reference is inside the interval, or the gap is under
 *   `MIN_PRACTICAL_DIFF`;
 * - `deviates`: the reference is outside the interval by a gap that matters;
 * - `too-few`: under `MIN_SAMPLE` decisions, or no reference.
 */
export type Verdict = "in-line" | "deviates" | "too-few";

export interface Comparison {
  /** The player's decisions in the denominator. */
  decisions: number;
  /** ... of which took one of the stat's actions. */
  made: number;
  /** made / decisions, or null with none. */
  yours: number | null;
  low: number | null;
  high: number | null;
  /** The range reference (decision-weighted over nodes; reach-weighted when the player has none). */
  reference: number | null;
  /** The hand-adjusted reference; null with no decisions. */
  adjusted: number | null;
  /** yours − reference. */
  diff: number | null;
  /** yours − adjusted. */
  adjustedDiff: number | null;
  verdict: Verdict;
}

export function compare(made: number, decisions: number, reference: number | null, adjusted: number | null): Comparison {
  const yours = decisions > 0 ? made / decisions : null;
  const interval = wilsonInterval(made, decisions);
  const diff = yours !== null && reference !== null ? yours - reference : null;
  const adjustedDiff = yours !== null && adjusted !== null ? yours - adjusted : null;
  let verdict: Verdict = "too-few";
  if (decisions >= MIN_SAMPLE && reference !== null && interval && diff !== null) {
    const outside = reference < interval.low || reference > interval.high;
    verdict = outside && Math.abs(diff) >= MIN_PRACTICAL_DIFF ? "deviates" : "in-line";
  }
  return {
    decisions,
    made,
    yours,
    low: interval?.low ?? null,
    high: interval?.high ?? null,
    reference,
    adjusted,
    diff,
    adjustedDiff,
    verdict,
  };
}

/* ------------------------------------------------------- the samples - */

/** One `analysis_node_actions.actions` row. */
export interface NodeActionCount {
  set: string;
  line: string;
  scenario: string;
  action: string;
  decisions: number;
  deviations: number;
  evLossBb: number;
}

/** One `analysis_node_actions.classes` row. */
export interface NodeClassCount {
  set: string;
  line: string;
  handClass: string;
  action: string;
  decisions: number;
}

/** The player's decisions at one chart node. */
export interface NodeSample {
  key: string;
  set: string;
  line: string;
  scenario: string;
  decisions: number;
  /** Decisions graded worse than Perfect. */
  deviations: number;
  evLossBb: number;
  actions: ActionFreq;
  /** Per hand class name, decisions (any action). */
  classes: Map<string, number>;
  /** Per hand class name and action, decisions. */
  classActions: Map<string, ActionFreq>;
}

const isAction = (value: string): value is ChartAction => (CHART_ACTIONS as readonly string[]).includes(value);

/** Groups the RPC's rows by node. Unknown action names are dropped. */
export function nodeSamples(actions: readonly NodeActionCount[], classes: readonly NodeClassCount[]): NodeSample[] {
  const byKey = new Map<string, NodeSample>();
  const sample = (set: string, line: string, scenario: string) => {
    const key = nodeKey(set, line);
    let found = byKey.get(key);
    if (!found) {
      found = {
        key,
        set,
        line,
        scenario,
        decisions: 0,
        deviations: 0,
        evLossBb: 0,
        actions: emptyFreq(),
        classes: new Map(),
        classActions: new Map(),
      };
      byKey.set(key, found);
    }
    return found;
  };
  for (const row of actions) {
    if (!isAction(row.action)) continue;
    const found = sample(row.set, row.line, row.scenario);
    found.decisions += row.decisions;
    found.deviations += row.deviations;
    found.evLossBb += row.evLossBb;
    found.actions[row.action] += row.decisions;
  }
  for (const row of classes) {
    if (!isAction(row.action)) continue;
    const found = byKey.get(nodeKey(row.set, row.line));
    if (!found) continue;
    found.classes.set(row.handClass, (found.classes.get(row.handClass) ?? 0) + row.decisions);
    const perAction = found.classActions.get(row.handClass) ?? emptyFreq();
    perAction[row.action] += row.decisions;
    found.classActions.set(row.handClass, perAction);
  }
  return [...byKey.values()];
}

/* ----------------------------------------------------------- per node - */

export interface NodeReport {
  sample: NodeSample;
  node: ChartNode;
  /** The node's own options plus any other action the player took (a fold the tree lacks). */
  actions: ChartAction[];
  range: RangeReference;
  adjusted: ActionFreq | null;
  /** Per action: the player against both references. */
  rows: Array<{ action: ChartAction; comparison: Comparison }>;
  /** The action whose frequency is furthest from the range reference. */
  widest: { action: ChartAction; diff: number } | null;
}

/** The comparison at one node, or null when the sample's node is not in this chart set. */
export function nodeReport(charts: ChartSet, sample: NodeSample, options: { cardRemoval?: boolean } = {}): NodeReport | null {
  if (sample.set !== charts.id) return null;
  const node = charts.nodes.get(sample.line);
  if (!node) return null;
  const range = rangeReference(charts, node, options);
  const adjusted = handAdjustedReference(node, sample.classes);
  const offered = new Set(node.options.map((option) => option.action));
  const actions = CHART_ACTIONS.filter((action) => offered.has(action) || sample.actions[action] > 0);
  const rows = actions.map((action) => ({
    action,
    comparison: compare(sample.actions[action], sample.decisions, range.freq[action], adjusted ? adjusted[action] : null),
  }));
  let widest: NodeReport["widest"] = null;
  for (const row of rows) {
    const diff = row.comparison.diff;
    if (diff !== null && (widest === null || Math.abs(diff) > Math.abs(widest.diff))) widest = { action: row.action, diff };
  }
  return { sample, node, actions, range, adjusted, rows, widest };
}

/* ------------------------------------------------------ familiar stats - */

/**
 * The stats rolled up from nodes. Each is defined on the charts' scenarios
 * (`ChartScenario`), which follow the statistics engine's counters
 * (`docs/STATS-SPEC.md` §6.1) with the differences the tree imposes:
 *
 * | Stat | Nodes | Counts as made |
 * |---|---|---|
 * | `rfi` | `rfi` (UTG–SB; the SB's limp is not an open) | raise, all-in |
 * | `steal` | `rfi` from CO, BTN, SB (`steal`) | raise, all-in |
 * | `three-bet` | `vs-open` (one raise, no callers; squeezes are their own) | raise, all-in |
 * | `blind-defence` | `vs-open`, actor SB or BB | call, raise, all-in |
 * | `fold-to-steal` | `vs-open` against a steal (`vsSteal`) | fold |
 * | `fold-to-three-bet-ip` / `-oop` | `vs-3bet`, the actor opened, in / out of position against the 3-bettor | fold |
 * | `four-bet` | `vs-3bet` (cold included) | raise, all-in |
 * | `squeeze` | `squeeze` (an open and one or more callers) | raise, all-in |
 */
export const REPORT_STATS = [
  "rfi",
  "steal",
  "three-bet",
  "blind-defence",
  "fold-to-steal",
  "fold-to-three-bet-ip",
  "fold-to-three-bet-oop",
  "four-bet",
  "squeeze",
] as const;
export type ReportStatId = (typeof REPORT_STATS)[number];

/** How a stat splits: the actor, and the player it is responding to (if any). */
export interface SplitKey {
  position: ChartPosition;
  versus: ChartPosition | null;
}

const RAISES: readonly ChartAction[] = ["raise", "allin"];
const FOLD: readonly ChartAction[] = ["fold"];
const DEFEND: readonly ChartAction[] = ["call", "raise", "allin"];

/** In position against `other` after the flop. */
export const inPositionAgainst = (actor: ChartPosition, other: ChartPosition) => POSTFLOP_ORDER[actor] > POSTFLOP_ORDER[other];

function foldToThreeBet(node: ChartNode, ip: boolean): SplitKey | null {
  if (node.scenario !== "vs-3bet" || node.cold || !node.facing) return null;
  if (openerOf(node.line) !== node.actor) return null;
  if (inPositionAgainst(node.actor, node.facing.position) !== ip) return null;
  return { position: node.actor, versus: node.facing.position };
}

export const STAT_SPECS: Readonly<
  Record<ReportStatId, { made: readonly ChartAction[]; applies: (node: ChartNode) => SplitKey | null }>
> = {
  rfi: {
    made: RAISES,
    applies: (node) => (node.scenario === "rfi" ? { position: node.actor, versus: null } : null),
  },
  steal: {
    made: RAISES,
    applies: (node) => (node.scenario === "rfi" && node.steal ? { position: node.actor, versus: null } : null),
  },
  "three-bet": {
    made: RAISES,
    applies: (node) =>
      node.scenario === "vs-open" && node.facing ? { position: node.actor, versus: node.facing.position } : null,
  },
  "blind-defence": {
    made: DEFEND,
    applies: (node) =>
      node.scenario === "vs-open" && node.facing && (node.actor === "SB" || node.actor === "BB")
        ? { position: node.actor, versus: node.facing.position }
        : null,
  },
  "fold-to-steal": {
    made: FOLD,
    applies: (node) =>
      node.scenario === "vs-open" && node.vsSteal && node.facing ? { position: node.actor, versus: node.facing.position } : null,
  },
  "fold-to-three-bet-ip": { made: FOLD, applies: (node) => foldToThreeBet(node, true) },
  "fold-to-three-bet-oop": { made: FOLD, applies: (node) => foldToThreeBet(node, false) },
  "four-bet": {
    made: RAISES,
    applies: (node) =>
      node.scenario === "vs-3bet" && node.facing ? { position: node.actor, versus: node.facing.position } : null,
  },
  squeeze: {
    made: RAISES,
    applies: (node) =>
      node.scenario === "squeeze" && node.facing ? { position: node.actor, versus: node.facing.position } : null,
  },
};

/** One node's part in a rolled-up stat. */
export interface StatPart {
  node: ChartNode;
  key: string;
  split: SplitKey;
  sample: NodeSample | null;
  /** Σ over the stat's actions of the range reference. */
  reference: number;
  /** Σ over the stat's actions of the hand-adjusted reference; null with no sample. */
  adjusted: number | null;
  made: number;
  decisions: number;
}

/**
 * Sums parts into one comparison. The reference is weighted by the player's
 * decisions at each node; with no decisions at all, by how often the
 * reference itself reaches each node (`node.reach`), so an empty row still
 * says what the reference does.
 */
export function aggregate(parts: readonly StatPart[]): Comparison {
  let decisions = 0;
  let made = 0;
  let reference = 0;
  let adjusted = 0;
  let adjustedWeight = 0;
  for (const part of parts) {
    decisions += part.decisions;
    made += part.made;
    reference += part.decisions * part.reference;
    if (part.adjusted !== null) {
      adjusted += part.decisions * part.adjusted;
      adjustedWeight += part.decisions;
    }
  }
  if (decisions > 0) {
    return compare(made, decisions, reference / decisions, adjustedWeight > 0 ? adjusted / adjustedWeight : null);
  }
  let reach = 0;
  let weighted = 0;
  for (const part of parts) {
    reach += part.node.reach;
    weighted += part.node.reach * part.reference;
  }
  return compare(0, 0, reach > 0 ? weighted / reach : null, null);
}

export interface StatSplit {
  key: SplitKey;
  comparison: Comparison;
  /** Node keys with the player's decisions, for the deviation list. */
  nodes: string[];
  deviations: number;
  evLossBb: number;
}

export interface StatReport {
  id: ReportStatId;
  made: readonly ChartAction[];
  total: Comparison;
  splits: StatSplit[];
  nodes: string[];
  deviations: number;
  evLossBb: number;
}

const splitId = (key: SplitKey) => `${key.position}|${key.versus ?? ""}`;

/** The parts of a set of made-actions over every node `applies` accepts. */
export function statParts(
  charts: ChartSet,
  samples: ReadonlyMap<string, NodeSample>,
  applies: (node: ChartNode) => SplitKey | null,
  made: readonly ChartAction[],
  options: { cardRemoval?: boolean } = {},
): StatPart[] {
  const parts: StatPart[] = [];
  for (const node of charts.nodes.values()) {
    const split = applies(node);
    if (!split) continue;
    const key = nodeKey(charts.id, node.line);
    const sample = samples.get(key) ?? null;
    const range = rangeReference(charts, node, options).freq;
    const adjustedFreq = sample ? handAdjustedReference(node, sample.classes) : null;
    parts.push({
      node,
      key,
      split,
      sample,
      reference: made.reduce((sum, action) => sum + range[action], 0),
      adjusted: adjustedFreq ? made.reduce((sum, action) => sum + adjustedFreq[action], 0) : null,
      made: sample ? made.reduce((sum, action) => sum + sample.actions[action], 0) : 0,
      decisions: sample?.decisions ?? 0,
    });
  }
  return parts;
}

function splitsOf(parts: readonly StatPart[]): StatSplit[] {
  const groups = new Map<string, StatPart[]>();
  for (const part of parts) {
    const id = splitId(part.split);
    groups.set(id, [...(groups.get(id) ?? []), part]);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group[0].split,
      comparison: aggregate(group),
      nodes: group.filter((part) => part.decisions > 0).map((part) => part.key),
      deviations: group.reduce((sum, part) => sum + (part.sample?.deviations ?? 0), 0),
      evLossBb: group.reduce((sum, part) => sum + (part.sample?.evLossBb ?? 0), 0),
    }))
    .sort(
      (a, b) =>
        TABLE_ORDER.indexOf(a.key.position) - TABLE_ORDER.indexOf(b.key.position) ||
        (a.key.versus ? TABLE_ORDER.indexOf(a.key.versus) : -1) - (b.key.versus ? TABLE_ORDER.indexOf(b.key.versus) : -1),
    );
}

/** One familiar stat, rolled up from the nodes, with its split by position. */
export function statReport(
  charts: ChartSet,
  samples: ReadonlyMap<string, NodeSample>,
  id: ReportStatId,
  options: { cardRemoval?: boolean } = {},
): StatReport {
  const spec = STAT_SPECS[id];
  const parts = statParts(charts, samples, spec.applies, spec.made, options);
  return {
    id,
    made: spec.made,
    total: aggregate(parts),
    splits: splitsOf(parts),
    nodes: parts.filter((part) => part.decisions > 0).map((part) => part.key),
    deviations: parts.reduce((sum, part) => sum + (part.sample?.deviations ?? 0), 0),
    evLossBb: parts.reduce((sum, part) => sum + (part.sample?.evLossBb ?? 0), 0),
  };
}

/** The blinds' defence against each opener: fold, call and 3-bet, side by side. */
export interface DefenceRow {
  key: SplitKey;
  fold: Comparison;
  call: Comparison;
  threeBet: Comparison;
  nodes: string[];
}

export function defenceTable(
  charts: ChartSet,
  samples: ReadonlyMap<string, NodeSample>,
  options: { cardRemoval?: boolean } = {},
): DefenceRow[] {
  const applies = STAT_SPECS["blind-defence"].applies;
  const fold = splitsOf(statParts(charts, samples, applies, FOLD, options));
  const call = splitsOf(statParts(charts, samples, applies, ["call"], options));
  const threeBet = splitsOf(statParts(charts, samples, applies, RAISES, options));
  return fold.map((row, i) => ({
    key: row.key,
    fold: row.comparison,
    call: call[i].comparison,
    threeBet: threeBet[i].comparison,
    nodes: row.nodes,
  }));
}

/* ------------------------------------------------------------ postflop - */

/** One `analysis_node_actions.postflop` row. */
export interface PostflopCount {
  street: string;
  scenario: string;
  action: string;
  decisions: number;
}

export type PostflopRoleId = "pfr-ip" | "pfr-oop" | "caller-ip" | "caller-oop";
export const POSTFLOP_ROLES: readonly PostflopRoleId[] = ["pfr-ip", "pfr-oop", "caller-ip", "caller-oop"];

export interface PostflopRoleStats {
  role: PostflopRoleId;
  /** First to act, or checked to: bet (a c-bet, a donk or a stab) against check. */
  first: { decisions: number; bet: number };
  /** Facing a bet: fold, call, raise. */
  vsBet: { decisions: number; fold: number; call: number; raise: number };
}

/**
 * The player's own postflop frequencies by role on one street, from the
 * scenario the engine stores (`pfr-ip-first`, `caller-oop-vs-bet`, …). Heads-up
 * only (a multiway decision is not analysed); limped pots have no raiser and
 * are left out. No reference until the flop library (A5).
 */
export function postflopRoles(rows: readonly PostflopCount[], street: string): PostflopRoleStats[] {
  const roles = new Map<PostflopRoleId, PostflopRoleStats>(
    POSTFLOP_ROLES.map((role) => [
      role,
      { role, first: { decisions: 0, bet: 0 }, vsBet: { decisions: 0, fold: 0, call: 0, raise: 0 } },
    ]),
  );
  for (const row of rows) {
    if (row.street !== street) continue;
    const match = /^(pfr|caller)-(ip|oop)-(first|vs-bet)$/.exec(row.scenario);
    if (!match) continue;
    const role = roles.get(`${match[1]}-${match[2]}` as PostflopRoleId);
    if (!role) continue;
    if (match[3] === "first") {
      role.first.decisions += row.decisions;
      if (row.action === "bet") role.first.bet += row.decisions;
    } else {
      role.vsBet.decisions += row.decisions;
      if (row.action === "fold") role.vsBet.fold += row.decisions;
      else if (row.action === "call") role.vsBet.call += row.decisions;
      else if (row.action === "raise") role.vsBet.raise += row.decisions;
    }
  }
  return [...roles.values()];
}
