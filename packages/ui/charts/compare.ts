/**
 * The user's chart against the hands they played (R5.3). Pure: the surface
 * hands over what was played, counted per situation, class and action
 * ({@link PlayedCell}, the database's `preflop_chart_played`), and this says
 * how much of it the chart plays, where it differs and what that cost.
 *
 * **On the chart** means the chart takes the action the hero took with that
 * class at least {@link OFF_CHART_BELOW_PERCENT} of the time - the shipped
 * charts' own line between Good and Inaccurate (`docs/ANALYSIS-PLAN.md` §2:
 * an action a chart plays under 3.5 % is a deviation), so a 50 % mix is
 * followed whichever way the hand went and a class the chart never raises
 * is a deviation when raised. A raise and an all-in stand for each other
 * where the chart has only one of them (a chart that "raises" a 5-bet
 * means the shove).
 *
 * **What it cost** is the EV the analysis put on those decisions against
 * Rail's own charts (`decision_analysis.ev_loss_bb`) - the only EV there is:
 * the user's chart has no EVs. Shown as that, never as the user chart's.
 */
import {
  CLASS_COUNT,
  CLASS_NAMES,
  PLAYED_ACTIONS,
  actionsOf,
  parseNodeKey,
  percentOf,
  restActionOf,
  type ChartNode,
  type ChartSet,
  type PlayedAction,
} from "./model";

/** Below this percent the chart does not play the action: a deviation. */
export const OFF_CHART_BELOW_PERCENT = 3.5;

/** Played decisions of one situation, class and action. */
export interface PlayedCell {
  /** `model.ts`' key; "" for a decision on the shipped tree that the vocabulary does not name. */
  key: string;
  cls: number;
  action: PlayedAction;
  decisions: number;
  /** Summed EV loss against Rail's charts, bb. */
  evLossBb: number;
}

/** The chart's percent for what the hero did, a raise and an all-in standing for each other when the chart has one only. */
export function chartPercent(node: ChartNode, key: string, action: PlayedAction, cls: number): number {
  const parsed = parseNodeKey(key);
  const rest = parsed ? restActionOf(parsed) : "fold";
  if (action === "fold" || action === "check") return action === rest ? percentOf(node, rest, cls) : 0;
  if (action === "call") return parsed && !actionsOf(parsed).includes("call") ? 0 : node.freq.call[cls];
  const raise = node.freq.raise[cls];
  const allin = node.freq.allin[cls];
  const hasRaise = node.freq.raise.some((v) => v > 0);
  const hasAllin = node.freq.allin.some((v) => v > 0);
  if (action === "raise") return hasAllin && !hasRaise ? allin : raise;
  return hasRaise && !hasAllin ? raise : allin;
}

/** The action the chart takes most often with a class (ties: the rest action, then raise, call, all-in). */
export function chartBest(node: ChartNode, key: string, cls: number): PlayedAction {
  const parsed = parseNodeKey(key);
  const rest = parsed ? restActionOf(parsed) : "fold";
  let best: PlayedAction = rest;
  let top = percentOf(node, rest, cls);
  for (const action of ["raise", "call", "allin"] as const) {
    const p = node.freq[action][cls];
    if (p > top) {
      top = p;
      best = action;
    }
  }
  return best;
}

export const isOnChart = (percent: number) => percent >= OFF_CHART_BELOW_PERCENT;

export interface Deviation {
  key: string;
  cls: number;
  className: string;
  /** What the hero did. */
  action: PlayedAction;
  decisions: number;
  /** The chart's percent for that action with that class. */
  chartPercent: number;
  /** What the chart does most with that class. */
  chartAction: PlayedAction;
  evLossBb: number;
}

export interface ActionMix {
  action: PlayedAction;
  /** Decisions that took it. */
  played: number;
  /** Decisions the chart would have put there, for the classes the hero was dealt. */
  expected: number;
}

export interface NodeComparison {
  key: string;
  decisions: number;
  onChart: number;
  /** Summed EV loss (Rail's charts) of the off-chart decisions. */
  offEvLossBb: number;
  mix: ActionMix[];
  /** Per class: decisions and how many were off the chart (the grid's colours). */
  classes: Array<{ decisions: number; off: number }>;
  deviations: Deviation[];
}

export interface ChartComparison {
  /** Decisions in situations the chart has. */
  decisions: number;
  onChart: number;
  offEvLossBb: number;
  nodes: NodeComparison[];
  /** Keyed situations the chart leaves empty, with how often they came up. */
  missing: Array<{ key: string; decisions: number }>;
  /** Decisions on the shipped tree the situations do not name (cold 4-bets, limped 3-bet pots, …). */
  unnamed: number;
  /** Every node's deviations, most frequent first. */
  deviations: Deviation[];
}

const byFrequency = (a: Deviation, b: Deviation) =>
  b.decisions - a.decisions || b.evLossBb - a.evLossBb || a.key.localeCompare(b.key) || a.cls - b.cls;

export function compareChart(chart: ChartSet, played: readonly PlayedCell[]): ChartComparison {
  const nodes = new Map<string, NodeComparison>();
  const missing = new Map<string, number>();
  const taken = new Map<string, Map<PlayedAction, number>>();
  let unnamed = 0;
  for (const cell of played) {
    if (cell.decisions <= 0 || cell.cls < 0 || cell.cls >= CLASS_COUNT) continue;
    if (cell.key === "") {
      unnamed += cell.decisions;
      continue;
    }
    const node = chart.nodes.get(cell.key);
    if (!node) {
      missing.set(cell.key, (missing.get(cell.key) ?? 0) + cell.decisions);
      continue;
    }
    let out = nodes.get(cell.key);
    if (!out) {
      out = {
        key: cell.key,
        decisions: 0,
        onChart: 0,
        offEvLossBb: 0,
        mix: [],
        classes: Array.from({ length: CLASS_COUNT }, () => ({ decisions: 0, off: 0 })),
        deviations: [],
      };
      nodes.set(cell.key, out);
    }
    out.decisions += cell.decisions;
    out.classes[cell.cls].decisions += cell.decisions;
    const actions = taken.get(cell.key) ?? new Map<PlayedAction, number>();
    actions.set(cell.action, (actions.get(cell.action) ?? 0) + cell.decisions);
    taken.set(cell.key, actions);
    const percent = chartPercent(node, cell.key, cell.action, cell.cls);
    if (isOnChart(percent)) {
      out.onChart += cell.decisions;
    } else {
      out.classes[cell.cls].off += cell.decisions;
      out.offEvLossBb += cell.evLossBb;
      out.deviations.push({
        key: cell.key,
        cls: cell.cls,
        className: CLASS_NAMES[cell.cls],
        action: cell.action,
        decisions: cell.decisions,
        chartPercent: percent,
        chartAction: chartBest(node, cell.key, cell.cls),
        evLossBb: cell.evLossBb,
      });
    }
  }

  for (const out of nodes.values()) {
    const node = chart.nodes.get(out.key) as ChartNode;
    const parsed = parseNodeKey(out.key);
    const rest = parsed ? restActionOf(parsed) : "fold";
    const allowed = new Set<PlayedAction>([rest, ...(parsed ? actionsOf(parsed) : [])]);
    const played = taken.get(out.key) ?? new Map<PlayedAction, number>();
    out.mix = PLAYED_ACTIONS.filter((action) => allowed.has(action) || (played.get(action) ?? 0) > 0).map((action) => {
      let expected = 0;
      if (allowed.has(action)) {
        for (let cls = 0; cls < CLASS_COUNT; cls += 1) {
          const n = out.classes[cls].decisions;
          if (n > 0) expected += (n * percentOf(node, action, cls)) / 100;
        }
      }
      return { action, played: played.get(action) ?? 0, expected };
    });
    out.deviations.sort(byFrequency);
  }

  const list = [...nodes.values()].sort((a, b) => b.decisions - a.decisions || a.key.localeCompare(b.key));
  return {
    decisions: list.reduce((sum, n) => sum + n.decisions, 0),
    onChart: list.reduce((sum, n) => sum + n.onChart, 0),
    offEvLossBb: list.reduce((sum, n) => sum + n.offEvLossBb, 0),
    nodes: list,
    missing: [...missing.entries()].map(([key, decisions]) => ({ key, decisions })).sort((a, b) => b.decisions - a.decisions),
    unnamed,
    deviations: list.flatMap((n) => n.deviations).sort(byFrequency),
  };
}
