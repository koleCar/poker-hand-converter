/**
 * A solved preflop game into a chart set (`format.ts`).
 *
 * One walk of the tree under the average strategy gives every node its
 * reach (the probability a hand gets there at all), the actor's range, and
 * the scenario facts; nodes reached less often than `minReach` are left out
 * of the set - their strategies are the least converged in the solve and the
 * lines are rare enough that "not in the chart set" is the honest answer.
 */

import type { PreflopSolver } from "../solver/preflopCfr";
import { comboShare, NUM_CLASSES } from "../solver/handClasses";
import {
  FLAG_COLD_CALL_CUT,
  FLAG_LIMP_CUT,
  FLAG_LIMPERS_CAP,
  FLAG_MULTIWAY_CAP,
  PF_ACTION,
  potAt,
} from "../solver/preflopTree";
import {
  CHARTS_VERSION,
  encodeEv,
  encodeFreq,
  encodeUnit,
  type ChartAction,
  type ChartNodeJson,
  type ChartPosition,
  type ChartScenario,
  type ChartSetJson,
} from "./format";

const H = NUM_CLASSES;
const STEAL_POSITIONS: readonly ChartPosition[] = ["CO", "BTN", "SB"];

const ACTION_OF: Record<string, ChartAction> = {
  f: "fold",
  k: "check",
  c: "call",
  r: "raise",
  a: "allin",
};

/**
 * A class whose range weight at a node is below this - the weight that the
 * stored uint8 range rounds to 0 - is "off range": the
 * average strategy there is not meaningful (CFR averages are weighted by how
 * often the class arrives, which is never), so the chart stores the best
 * response to the charts instead - the highest-EV action. That is what a
 * player who got there anyway (an UTG open with 54s, then facing a 3-bet)
 * should do, and it is what EV loss is measured against.
 */
export const OFF_RANGE = 0.5 / 255;

/**
 * A node is left out when, for some class in the actor's range, the chart's
 * own mix loses more than this fraction of the pot against that class's best
 * action at the chart's final EVs. That happens at nodes the equilibrium
 * stops visiting early in the solve (a cold squeeze over a flat that the
 * charts end up never making): CFR only learns where the opponents' reach is
 * positive, so their average strategy is a relic of the first iterations.
 * 2% of the pot is the grading boundary between "Inaccurate" and "Mistake"
 * (ANALYSIS-PLAN §2): a node that would grade its own strategy a mistake is
 * not a reference.
 */
export const MAX_SELF_LOSS = 0.02;
/** "In range" for `MAX_SELF_LOSS`: at least 5% of the class arrives at the node. */
export const IN_RANGE = 0.05;

export interface BuildChartOptions {
  id: string;
  /** The generator version written as `version`. Default `CHARTS_VERSION`. */
  version?: string;
  /** Nodes reached less often than this are not written. */
  minReach: number;
  /**
   * Nodes behind an open limp (a seat other than the blinds limped) are kept
   * down to this reach instead (`charts/4`): they are reached through the
   * limp's tremble, off the equilibrium path, and are what grades a hero
   * facing a limper. Default `minReach`.
   */
  minLimpReach?: number;
  /** Assumptions and convergence, written as `model` (a hash is added). */
  model: Record<string, unknown>;
}

/** 32-bit FNV-1a of a string, hex. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let k = 0; k < text.length; k += 1) {
    h ^= text.charCodeAt(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Rounds for the JSON: stable text, no float noise. */
function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

interface Step {
  actor: number;
  code: string;
}

/** Probability of reaching every action node under the average strategy (NaN elsewhere). */
export function nodeReaches(solver: PreflopSolver): Float64Array {
  const tree = solver.tree;
  const n = tree.players.length;
  const out = new Float64Array(tree.size).fill(NaN);
  const reach = new Float64Array(n * H).fill(1);
  const visit = (node: number): void => {
    if (tree.type[node] !== PF_ACTION) return;
    let r = 1;
    for (let p = 0; p < n; p += 1) r *= comboShare(reach.subarray(p * H, p * H + H));
    out[node] = r;
    const actor = tree.actor[node];
    const strat = solver.averageStrategy(node);
    const save = reach.slice(actor * H, actor * H + H);
    for (let a = 0; a < tree.childCount[node]; a += 1) {
      for (let i = 0; i < H; i += 1) reach[actor * H + i] = save[i] * strat[a * H + i];
      visit(tree.children[tree.childStart[node] + a]);
    }
    reach.set(save, actor * H);
  };
  visit(0);
  return out;
}

/**
 * Builds the chart set. `solver.evaluate()` must have run (EVs are read from
 * `solver.ev`).
 */
export function buildChartSet(solver: PreflopSolver, options: BuildChartOptions): ChartSetJson {
  const tree = solver.tree;
  const ev = solver.ev;
  if (!ev) {
    throw new Error("run solver.evaluate() before building charts");
  }
  const n = tree.players.length;
  const positions = tree.players as readonly ChartPosition[];
  const nodes: ChartNodeJson[] = [];

  const reach = new Float64Array(n * H).fill(1);
  const steps: Step[] = [];
  const unconverged: { line: string; reach: number; loss: number }[] = [];

  /** Whether a seat other than the blinds limped (called before any raise) on the way here. */
  const openLimped = (path: readonly Step[]): boolean => {
    for (const step of path) {
      if (step.code === "r" || step.code === "a") return false;
      if (step.code === "c" && positions[step.actor] !== "SB" && positions[step.actor] !== "BB") return true;
    }
    return false;
  };

  const visit = (node: number): void => {
    if (tree.type[node] !== PF_ACTION) return;
    const actor = tree.actor[node];
    const count = tree.childCount[node];
    const start = tree.childStart[node];
    const strat = solver.averageStrategy(node);

    let nodeReach = 1;
    for (let p = 0; p < n; p += 1) {
      nodeReach *= comboShare(reach.subarray(p * H, p * H + H));
    }

    // Behind a non-blind seat's limp, the lower threshold.
    const threshold = openLimped(steps) ? (options.minLimpReach ?? options.minReach) : options.minReach;
    if (nodeReach >= threshold) {
      const loss = selfLoss(node, actor, strat);
      if (loss <= MAX_SELF_LOSS) {
        nodes.push(describe(node, actor, nodeReach, strat));
      } else {
        unconverged.push({ line: tree.line[node], reach: nodeReach, loss });
      }
    }

    const save = reach.slice(actor * H, actor * H + H);
    for (let a = 0; a < count; a += 1) {
      for (let i = 0; i < H; i += 1) reach[actor * H + i] = save[i] * strat[a * H + i];
      steps.push({ actor, code: tree.edgeCode[start + a] });
      visit(tree.children[start + a]);
      steps.pop();
    }
    reach.set(save, actor * H);
  };

  /**
   * The largest EV the chart's own strategy gives up at this node, over the
   * classes in the actor's range: `Σ_a freq_a (best EV - EV_a)`, as a
   * fraction of the pot.
   */
  const selfLoss = (node: number, actor: number, strat: Float64Array): number => {
    const count = tree.childCount[node];
    const off = solver.offset[node];
    const pot = potAt(tree, node);
    let worst = 0;
    for (let i = 0; i < H; i += 1) {
      if (reach[actor * H + i] < IN_RANGE) continue;
      let best = -Infinity;
      for (let a = 0; a < count; a += 1) best = Math.max(best, ev[off + a * H + i]);
      let loss = 0;
      for (let a = 0; a < count; a += 1) loss += strat[a * H + i] * (best - ev[off + a * H + i]);
      worst = Math.max(worst, loss / pot);
    }
    return worst;
  };

  const describe = (node: number, actor: number, nodeReach: number, strat: Float64Array): ChartNodeJson => {
    const count = tree.childCount[node];
    const start = tree.childStart[node];
    const level = tree.level[node];
    const position = positions[actor];
    const voluntary = (tree.voluntary[node] & (1 << actor)) !== 0;
    const aggressor = tree.aggressor[node];

    // Opener, limpers and the callers of the current raise, from the explicit steps.
    let opener = -1;
    const limpers: number[] = [];
    let raises = 0;
    let callers: number[] = [];
    let firstDecision = true;
    for (const step of steps) {
      if (step.actor === actor) firstDecision = false;
      if (step.code === "r" || step.code === "a") {
        raises += 1;
        if (raises === 1) opener = step.actor;
        callers = [];
      } else if (step.code === "c") {
        if (raises === 0) limpers.push(step.actor);
        else callers.push(step.actor);
      }
    }
    // An isolation raise: the first raise, over one or more limpers.
    const isoRaise = level === 1 && limpers.length > 0 && opener === aggressor;

    let scenario: ChartScenario;
    if (level === 0) scenario = limpers.length ? "vs-limp" : "rfi";
    else if (level === 1) {
      // A limper facing the isolation raise; anyone else faces a raise like an open.
      scenario = isoRaise && limpers.includes(actor) ? "vs-iso" : callers.length ? "squeeze" : "vs-open";
    }
    else if (level === 2) scenario = "vs-3bet";
    else if (level === 3) scenario = "vs-4bet";
    else scenario = "vs-allin";

    const out: ChartNodeJson = {
      line: tree.line[node],
      actor: position,
      scenario,
      potBb: round(potAt(tree, node), 2),
      inBb: tree.contrib[node * n + actor],
      toMatchBb: tree.toMatch[node],
      reach: round(nodeReach, 6),
      options: [],
      freq: "",
      ev: "",
      range: "",
    };
    if (scenario === "rfi" && STEAL_POSITIONS.includes(position)) out.steal = true;
    if (
      level === 1 &&
      !isoRaise &&
      firstDecision &&
      (position === "SB" || position === "BB") &&
      STEAL_POSITIONS.includes(positions[opener])
    ) {
      out.vsSteal = true;
    }
    if (level >= 2 && !voluntary) out.cold = true;
    if (aggressor >= 0) out.facing = { position: positions[aggressor], toBb: tree.toMatch[node] };
    if (callers.length) out.callers = callers.map((p) => positions[p]);
    if (limpers.length) out.limpers = limpers.map((p) => positions[p]);
    const cut: ("multiway-call" | "cold-call" | "limp" | "limpers-cap")[] = [];
    if (tree.flags[node] & FLAG_MULTIWAY_CAP) cut.push("multiway-call");
    if (tree.flags[node] & FLAG_COLD_CALL_CUT) cut.push("cold-call");
    if (tree.flags[node] & FLAG_LIMP_CUT) cut.push("limp");
    if (tree.flags[node] & FLAG_LIMPERS_CAP) cut.push("limpers-cap");
    if (cut.length) out.cut = cut;

    for (let a = 0; a < count; a += 1) {
      const code = tree.edgeCode[start + a];
      out.options.push({ code, action: ACTION_OF[code], toBb: tree.edgeTo[start + a] });
    }
    const off = solver.offset[node];
    const freq = Float64Array.from(strat);
    for (let i = 0; i < H; i += 1) {
      if (reach[actor * H + i] >= OFF_RANGE) continue;
      let best = 0;
      for (let a = 1; a < count; a += 1) {
        if (ev[off + a * H + i] > ev[off + best * H + i]) best = a;
      }
      for (let a = 0; a < count; a += 1) freq[a * H + i] = a === best ? 1 : 0;
    }
    out.freq = encodeFreq(freq, count);
    out.ev = encodeEv(ev.subarray(off, off + count * H));
    out.range = encodeUnit(reach.subarray(actor * H, actor * H + H));
    return out;
  };

  visit(0);

  const body: ChartSetJson = {
    version: options.version ?? CHARTS_VERSION,
    id: options.id,
    game: {
      variant: "holdem" as const,
      limit: "nl" as const,
      format: "cash" as const,
      players: n,
      positions: [...positions],
      stackBb: tree.stackBb,
    },
    model: {
      ...options.model,
      excluded: {
        rule: `nodes reached less often than ${options.minReach}, and nodes where the chart's own mix loses more than ${MAX_SELF_LOSS * 100}% of the pot for a class in range`,
        unconverged: unconverged.map((u) => ({ line: u.line, reach: round(u.reach, 7), lossPot: round(u.loss, 4) })),
      },
      hash: "",
    },
    nodes,
  };
  body.model.hash = fnv1a(JSON.stringify({ ...body, model: { ...body.model, hash: "" } }));
  return body;
}
