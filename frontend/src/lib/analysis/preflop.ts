/**
 * Preflop grading from the charts (`docs/ANALYSIS-PLAN.md` §3.1, phase A2b),
 * and the opponents' preflop ranges the charts imply.
 *
 * ```
 * PhfHand ─▶ preflopSpotFromHand ─▶ lookupPreflop ─▶ options for the hero's class
 *                                                  └▶ grade() (§2)
 * ```
 *
 * Everything chart-shaped comes through `lib/charts`' public API. The charts
 * are passed in, never loaded here: the JSON is ~630 KB, and the caller (the
 * Web Worker, a test, the hand view) decides when to pay for it.
 *
 * **A refusal is an answer.** A line the charts cannot represent — heads-up,
 * a depth no set covers, an open limp, a line too rare to be in the set — is a
 * `not-analysed` decision with the lookup's reason, never a guess (§3.5).
 *
 * **EV units.** A chart EV is net chips from the start of the hand, so EV loss
 * is a difference between two options, and folding is worth exactly minus
 * what the actor has in already. That is what lets a fold the tree does not
 * offer (the big blind folding to a limp, when a check was free) still be
 * graded: it is added as a zero-frequency option at that exact EV.
 */

import { allClasses, type ClassWeights } from "../equity/range";
import {
  CHARTS_VERSION,
  isOpenLimpNode,
  OFF_RANGE,
  handClassOf,
  isChartLibrary,
  lookupPreflop,
  pickChartSet,
  preflopSpotFromHand,
  straddleMismatch,
  type ChartApproximation,
  type ChartLookup,
  type ChartSet,
  type PreflopActionInput,
} from "../charts";
import type { PhfHand } from "../phf/types";
import { grade, type GradeResult } from "./grading";
import type { Approximation, ChartRef, ChartSkipReason, OptionAnalysis } from "./types";

/**
 * Chart-set versions with a known modelling weakness: every grade from them
 * carries the `model` approximation. `charts/1` under-rated implied-odds
 * hands broadly (§3.1 "Known weakness"). `charts/2` (A2a.1) fits the
 * realisation to our postflop solver and fixes most of it, but still values
 * a flop with the flop checked (`docs/CHARTS.md` §9): UTG folds 55–22,
 * 87s–54s and A5s, and the button almost never flats a cutoff open. It stays
 * on the list, and `modelCaveat` names those hands. `charts/4` (A2d, limp
 * trees), `charts/3` (A2c), `charts/5` (A2e, the straddle set) and
 * `charts/6` (the 200bb sets solved longer) are the same model at other
 * tables, depths and blinds, with the same weakness.
 */
export const WEAK_CHART_VERSIONS: readonly string[] = ["charts/1", "charts/2", "charts/3", "charts/4", "charts/5", "charts/6"];

/** Probability mass, in combos, below which a chart range is too thin to measure an equity against. */
const MIN_RANGE_COMBOS = 1;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round2 = (value: number) => Math.round(value * 100) / 100;

export interface PreflopGradeInput {
  hand: PhfHand;
  heroSeat: number;
  /** The hero's `nth` preflop decision (0 = first). */
  nth: number;
  /** `PhfAction.index` of the decision: checked against the chart's own reading. */
  actionIndex: number;
  /** Pot before the decision, bb: what EV loss is quoted against. */
  potBb: number;
}

export type PreflopGrade =
  | ({
      ok: true;
      options: OptionAnalysis[];
      chosen: number;
      approximations: Approximation[];
      chart: ChartRef;
      handClass: string;
    } & GradeResult)
  | { ok: false; reason: ChartSkipReason; detail: string };

const refuse = (reason: string, detail: string): PreflopGrade => ({
  ok: false,
  reason: `chart-${reason}` as ChartSkipReason,
  detail,
});

/** The chart's options in the analysis vocabulary, rounded to what is stored. */
function optionsOf(lookup: Extract<ChartLookup, { ok: true }>): OptionAnalysis[] {
  return lookup.options.map((option) => ({
    action: option.action === "allin" ? "raise" : option.action,
    sizeBb: round2(option.sizeBb),
    ...(option.action === "allin" ? { allIn: true } : {}),
    freq: round4(option.freq),
    ev: round3(option.ev),
  }));
}

function chartApproximations(charts: ChartSet, list: readonly ChartApproximation[]): Set<Approximation> {
  const out = new Set<Approximation>();
  if (WEAK_CHART_VERSIONS.includes(charts.version)) out.add("model");
  for (const item of list) {
    if (item.kind === "short-handed") out.add("short-handed");
    else if (item.kind === "stack-depth") out.add("stack-depth-near");
    else if (item.kind === "sizing" && item.offTree) out.add("off-tree-size");
  }
  return out;
}

/** A refusal for a call the tree cut at this node, named by the cut rather than "not modelled". */
function cutReason(cut: readonly string[], action: PreflopActionInput["type"]): string | null {
  if (action !== "call") return null;
  if (cut.includes("limp")) return "limp";
  if (cut.includes("limpers-cap")) return "multiway";
  if (cut.includes("cold-call")) return "cold-call";
  if (cut.includes("multiway-call")) return "multiway";
  return null;
}

/**
 * Grades one hero preflop decision against the charts, or says why it cannot.
 * Pure and deterministic; `charts` null is `chart-unavailable`.
 */
export function gradePreflop(input: PreflopGradeInput, charts: ChartSet | null): PreflopGrade {
  if (!charts) return refuse("unavailable", "the charts were not loaded");
  const found = preflopSpotFromHand(input.hand, input.nth, input.heroSeat);
  if (!found.ok) return refuse(found.reason, found.detail);
  if (found.actionIndex !== input.actionIndex) {
    return refuse("bad-input", `the charts read action #${found.actionIndex} as decision ${input.nth}`);
  }
  if (!found.heroCards) return refuse("bad-input", "the hero's cards are unknown");

  const heroAction = found.heroAction;
  let lookup = lookupPreflop(charts, found.spot, found.heroCards, heroAction);
  let options: OptionAnalysis[];
  let chosen: number;

  if (lookup.ok && lookup.chosen !== null && lookup.chosen >= 0) {
    options = optionsOf(lookup);
    chosen = lookup.chosen;
  } else if (lookup.ok || lookup.reason === "action-not-modelled") {
    // The node exists but the hero's action is not one of its edges. Look the
    // node up alone to name what is missing.
    const bare = lookupPreflop(charts, found.spot, found.heroCards, null);
    if (!bare.ok) return refuse(bare.reason, bare.detail);
    const cut = cutReason(bare.node.cut, heroAction.type);
    if (cut) return refuse(cut, `${found.spot.hero} ${heroAction.type}s where the tree has no ${heroAction.type}`);
    if (heroAction.type !== "fold") {
      return refuse("action-not-modelled", lookup.ok ? "the hero's action is not an option here" : lookup.detail);
    }
    // A fold where the tree only checks or raises: worth exactly what is
    // already in, never played by the reference.
    lookup = bare;
    options = [...optionsOf(bare), { action: "fold", sizeBb: round2(bare.node.inBb), freq: 0, ev: round3(-bare.node.inBb) }];
    chosen = options.length - 1;
  } else {
    return refuse(lookup.reason, lookup.detail);
  }
  if (!lookup.ok) return refuse("bad-input", "unreachable");

  // The set that answered: `charts` itself, or a library's set for this table and depth.
  const approximations = chartApproximations(lookup.set, lookup.approximations);
  // Behind an open limp the reference's limper is the tremble's: any hand (charts/4).
  if (isOpenLimpNode(lookup.node)) approximations.add("limp-tremble");
  const inRange = lookup.inRange ?? 0;
  if (inRange < OFF_RANGE) approximations.add("out-of-range");
  const result = grade({
    options,
    chosen,
    pot: input.potBb,
    capAtInaccurate: approximations.has("off-tree-size"),
  });
  return {
    ok: true,
    options,
    chosen,
    approximations: [...approximations].sort(),
    chart: { set: lookup.set.id, line: lookup.node.line, scenario: lookup.node.scenario, inRange: round4(inRange) },
    handClass: lookup.handClass ?? "",
    grade: result.grade,
    evLoss: round3(result.evLoss),
    evLossPot: Number.isFinite(result.evLossPot) ? round4(result.evLossPot) : 1,
    freqDiff: round4(result.freqDiff),
    score: round2(result.score),
  };
}

/**
 * Whether the charts model this hand's straddle (A2e): the hero's first
 * preflop spot is one a straddle set answers - a single 2bb straddle from
 * the first seat left of the big blind, 4-6 handed, near 100bb. Such a hand
 * is graded preflop and its ranges start from that set, so it does not carry
 * the hand-level `straddle` approximation.
 */
export function chartsModelStraddle(hand: PhfHand, heroSeat: number, charts: ChartSet | null): boolean {
  if (!charts) return false;
  const found = preflopSpotFromHand(hand, 0, heroSeat);
  if (!found.ok || !found.spot.straddle) return false;
  if (isChartLibrary(charts)) return pickChartSet(charts.specs, found.spot).ok;
  return straddleMismatch(charts.game.straddle ?? null, charts.game.positions.length, found.spot) === null;
}

/* ---------------------------------------------------------------- ranges - */

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const CLASS_NAMES = allClasses();
const COMBOS_OF = (name: string) => (name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12);

export interface ChartRange {
  range: ClassWeights;
  /** The node the range was read at. */
  line: string;
  /** Weighted combos in the range, before card removal. */
  combos: number;
}

/** Whether `position` called before any raise (limped) from a seat other than the blinds. */
function openLimped(position: string, actions: readonly PreflopActionInput[]): boolean {
  if (position === "SB" || position === "BB") return false;
  for (const action of actions) {
    if (action.type === "raise") return false;
    if (action.type === "call" && action.position === position) return true;
  }
  return false;
}

/**
 * An opponent's preflop range as the charts play their line: at the node of
 * their last preflop decision before `beforeActionIndex`, each class weighted
 * by how much of it reaches the node and how often it then takes the action
 * the opponent took — `range[class] × freq[action][class]`, the product of the
 * frequencies along their whole line. Null when the charts have no node for
 * the line (the caller falls back to the labelled placeholder).
 */
export function chartRange(
  hand: PhfHand,
  seat: number,
  beforeActionIndex: number,
  charts: ChartSet | null,
): ChartRange | null {
  if (!charts) return null;
  let nth = -1;
  for (const action of hand.actions) {
    if (action.index >= beforeActionIndex) break;
    if (action.street === "preflop" && action.seat === seat && DECISIONS.has(action.type)) nth += 1;
  }
  if (nth < 0) return null;
  const found = preflopSpotFromHand(hand, nth, seat);
  if (!found.ok || found.heroAction.type === "fold") return null;
  // A seat other than the blinds that limped: in the charts (`charts/4`) its
  // limp is the tremble - every class, "a limper may hold anything" - which
  // is what the players facing it are graded against, but no range to start
  // a postflop walk from. The labelled placeholder limp range is better.
  if (openLimped(found.spot.hero, [...found.spot.actions, found.heroAction])) return null;
  const lookup = lookupPreflop(charts, found.spot, null, found.heroAction);
  if (!lookup.ok || lookup.chosen === null || lookup.chosen < 0) return null;
  const node = lookup.node;
  const classes = node.range.length;
  const weights = new Map<string, number>();
  let combos = 0;
  for (const name of CLASS_NAMES) {
    const k = handClassOf(name);
    if (k < 0) continue;
    const weight = node.range[k] * node.freq[lookup.chosen * classes + k];
    if (weight > 0) {
      weights.set(name, Math.min(1, weight));
      combos += weight * COMBOS_OF(name);
    }
  }
  if (combos < MIN_RANGE_COMBOS) return null;
  return { range: weights, line: node.line, combos: round2(combos) };
}

/** The charts' format version, re-exported so callers can name what they graded against. */
export { CHARTS_VERSION };
