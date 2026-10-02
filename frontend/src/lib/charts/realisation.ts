/**
 * Fitting the preflop realisation model to the postflop solver (`charts/2`).
 *
 * The preflop solve values a pot that sees a flop with `lib/solver`'s odds-form
 * realisation model (`preflopModel.ts`). `charts/1` set its numbers by hand;
 * here they are measured:
 *
 * 1. **Spots.** `REALISATION_SPOTS` are heads-up flop terminals of the
 *    tree, two or more per pot type, chosen so every role appears: the raiser
 *    in position against a caller (BTN open, BB call), out of position (CO
 *    open, BTN call; SB open, BB call), and so on for 3-bet and 4-bet pots,
 *    and the limped blind-versus-blind pot. Each player's range there is its
 *    reach under the current charts (`PreflopSolver.reachAt`), or, for the
 *    button's flat and the small blind's limp, every hand that continues
 *    there (`RealisationSpotSpec.candidates`).
 * 2. **Measurement.** For each spot, `boards` seeded flop+turn deals (every
 *    river card, by default); `measureRealisation` solves the turn and
 *    river (flop checked through, see its header) and returns per class the
 *    share of the pot each player realised and its check-down equity on the
 *    same deals. The jobs are independent, so the script runs them on worker
 *    threads; nothing here depends on the order they finish in.
 * 3. **Fit.** Per class, the realisation ratio `R = share / equity` (both
 *    summed over the same deals, so most board-sampling noise cancels) times
 *    the class's equity against the opponent's range from the 169x169 table is
 *    the **target share**. The model's share of the same class against the
 *    same range is a function of the coefficients; per pot type,
 *    Levenberg-Marquardt minimises the probability-weighted squared error over
 *    every spot, both players and every class in range, with a small ridge
 *    penalty on the coefficients; raiser and caller in the same seat share
 *    their class coefficients. Classes the odds form cannot represent - a
 *    realised share above 0.92 of the pot (AA wins the stacks, not just the
 *    pot) - are left out of the fit and take the feature model's value.
 *
 * The fitted model replaces the current one and the preflop game is solved
 * again: the ranges move, so the measurement is repeated (`rounds`), towards
 * a fixed point between the charts and the realisation they imply. Each fit
 * pools the measurements of every round so far: a class's realisation in a
 * role is measured against several ranges, and a role whose range was a
 * handful of classes in one round (the button's flat in `charts/1`) is not
 * fitted on that alone.
 *
 * Deterministic: seeded boards, a deterministic solver, sums in job order.
 */

import { mulberry32 } from "../equity";
import { NUM_COMBOS } from "../solver/combos";
import { combosOfClass, COMPAT, HAND_CLASSES, NUM_CLASSES, type HandClass } from "../solver/handClasses";
import type { PreflopSolver } from "../solver/preflopCfr";
import {
  CHARTS1_REALISATION,
  CLASS_FEATURES,
  POT_TYPES,
  REALISATION_FEATURES,
  REALISATION_ROLES,
  roleWeights,
  type PotType,
  type RealisationFeature,
  type RealisationModel,
  type RealisationRole,
  type RoleRealisation,
} from "../solver/preflopModel";
import {
  addSample,
  emptySample,
  measureRealisation,
  REALISATION_MENU,
  type RealisationSample,
  type RealisationSpot,
} from "../solver/preflopRealisation";
import {
  PF_ACTION,
  PF_FLOP,
  POSTFLOP_ORDER,
  POT_TYPE_INDEX,
  potAt,
  type PreflopPosition,
  type PreflopTree,
} from "../solver/preflopTree";
import { generateChartSet, type GenerateOptions, type GenerateResult } from "./generate";

const H = NUM_CLASSES;
const NF = REALISATION_FEATURES.length;

/**
 * A heads-up flop terminal whose two players' realisation is measured, as the
 * voluntary actions that lead to it (everyone else folds when it is their
 * turn): `[["BTN", "r"], ["BB", "c"]]` is "BTN opens, BB calls".
 *
 * `candidates`: the player whose range is measured as **every hand that
 * continues** at its scripted decision (calls or raises), not only the hands
 * that take the scripted action. For actions the charts take rarely - the
 * button's flat, the small blind's limp - the range that takes the action
 * is a handful of classes that can vanish or reappear between rounds, and a
 * fit on it swings with it; the hands that continue are the candidates for
 * the action, and how they realise when they take it is what the preflop
 * solve needs to decide whether they should.
 */
export interface RealisationSpotSpec {
  potType: PotType;
  actions: readonly (readonly [PreflopPosition, "r" | "c" | "k"])[];
  candidates?: PreflopPosition;
}

/**
 * The measured spots. Every pot type has its raiser both in and out of
 * position where the tree allows; the limped pot is the blinds'.
 */
export const REALISATION_SPOTS: readonly RealisationSpotSpec[] = [
  // Single-raised: raiser in position against the big blind ...
  { potType: "srp", actions: [["BTN", "r"], ["BB", "c"]] },
  { potType: "srp", actions: [["CO", "r"], ["BB", "c"]] },
  { potType: "srp", actions: [["UTG", "r"], ["BB", "c"]] },
  // ... and out of position against a caller.
  { potType: "srp", actions: [["CO", "r"], ["BTN", "c"]], candidates: "BTN" },
  { potType: "srp", actions: [["UTG", "r"], ["BTN", "c"]], candidates: "BTN" },
  { potType: "srp", actions: [["SB", "r"], ["BB", "c"]] },
  // 3-bet: the blinds 3-bet the button (raiser out of position) ...
  { potType: "3bet", actions: [["BTN", "r"], ["BB", "r"], ["BTN", "c"]] },
  { potType: "3bet", actions: [["BTN", "r"], ["SB", "r"], ["BTN", "c"]] },
  // ... the button 3-bets an earlier open (raiser in position).
  { potType: "3bet", actions: [["CO", "r"], ["BTN", "r"], ["CO", "c"]] },
  { potType: "3bet", actions: [["UTG", "r"], ["BTN", "r"], ["UTG", "c"]] },
  // 4-bet: raiser in position, and out of position.
  { potType: "4bet", actions: [["BTN", "r"], ["BB", "r"], ["BTN", "r"], ["BB", "c"]] },
  { potType: "4bet", actions: [["CO", "r"], ["BTN", "r"], ["CO", "r"], ["BTN", "c"]] },
  // Limped: the small blind completes, the big blind checks.
  { potType: "limped", actions: [["SB", "c"], ["BB", "k"]], candidates: "SB" },
];

/**
 * The terminal a spec leads to in this tree, or -1 (a player missing, an
 * action not offered); `decisions` gets the node of each scripted action.
 */
export function spotTerminal(tree: PreflopTree, spec: RealisationSpotSpec, decisions: number[] = []): number {
  let node = 0;
  let next = 0;
  decisions.length = 0;
  while (tree.type[node] === PF_ACTION) {
    const position = tree.players[tree.actor[node]];
    const want = next < spec.actions.length && spec.actions[next][0] === position ? spec.actions[next][1] : "f";
    if (want !== "f") {
      next += 1;
      decisions.push(node);
    }
    const start = tree.childStart[node];
    let child = -1;
    for (let e = start; e < start + tree.childCount[node]; e += 1) {
      if (tree.edgeCode[e] === want) child = tree.children[e];
    }
    if (child < 0) return -1;
    node = child;
  }
  return tree.type[node] === PF_FLOP && next === spec.actions.length ? node : -1;
}

export interface RealisationMeasureOptions {
  /** Flop+turn deals per spot. */
  boards: number;
  /**
   * River cards sampled per deal (dead for both ranges); 0 deals all 44. A
   * sample is for tests: measured on the same deals it reads ~2% more
   * realisation for the caller than every river does.
   */
  rivers: number;
  /** DCFR iterations per turn+river solve. */
  iterations: number;
  seed: number;
  /** Classes reaching a spot less than this are left out of its ranges (compute). */
  minClassReach: number;
}

export const PRODUCTION_MEASURE: Readonly<RealisationMeasureOptions> = {
  boards: 120,
  rivers: 0,
  iterations: 60,
  seed: 0x7ea1,
  minClassReach: 0.01,
};

/** One spot ready to measure: its ranges, pot, stack, and roles. */
export interface PreparedSpot {
  line: string;
  potType: PotType;
  /** Player 0 is out of position. */
  roles: [RealisationRole, RealisationRole];
  /** Seats; a `+` marks a candidates range (`RealisationSpotSpec.candidates`). */
  positions: [string, string];
  /** Class reach of each player at the terminal. */
  ranges: [Float64Array, Float64Array];
  pot: number;
  stack: number;
  /** Combos (reach-weighted) in each range. */
  combos: [number, number];
  /** The generator round whose solve the ranges came from. */
  round?: number;
}

/**
 * The spots of `REALISATION_SPOTS` that exist in this tree with a big enough
 * range on both sides (at least `minCombos` reach-weighted combos).
 */
export function prepareSpots(solver: PreflopSolver, minClassReach: number, minCombos = 8): PreparedSpot[] {
  const tree = solver.tree;
  const out: PreparedSpot[] = [];
  for (const spec of REALISATION_SPOTS) {
    const decisions: number[] = [];
    const node = spotTerminal(tree, spec, decisions);
    if (node < 0 || POT_TYPE_INDEX[tree.potType[node]] !== spec.potType) continue;
    const live: number[] = [];
    for (let p = 0; p < tree.players.length; p += 1) if (tree.live[node] & (1 << p)) live.push(p);
    if (live.length !== 2) continue;
    const order = live.map((p) => POSTFLOP_ORDER[tree.players[p]]);
    const [oop, ip] = order[0] < order[1] ? [live[0], live[1]] : [live[1], live[0]];
    const reach = solver.reachAt(node);
    if (spec.candidates) {
      // The candidates' reach: at their last scripted decision, times not folding there.
      const p = tree.players.indexOf(spec.candidates);
      let at = -1;
      spec.actions.forEach(([position], k) => {
        if (position === spec.candidates) at = decisions[k];
      });
      if (p >= 0 && at >= 0) {
        const before = solver.reachAt(at);
        const strat = solver.averageStrategy(at);
        const start = tree.childStart[at];
        let fold = -1;
        for (let e = 0; e < tree.childCount[at]; e += 1) if (tree.edgeCode[start + e] === "f") fold = e;
        for (let i = 0; i < H; i += 1) {
          reach[p * H + i] = before[p * H + i] * (fold >= 0 ? 1 - strat[fold * H + i] : 1);
        }
      }
    }
    const agg = tree.aggressor[node];
    const range = (p: number) => {
      const r = new Float64Array(H);
      for (let i = 0; i < H; i += 1) {
        const v = reach[p * H + i];
        r[i] = v >= minClassReach ? v : 0;
      }
      return r;
    };
    const ranges: [Float64Array, Float64Array] = [range(oop), range(ip)];
    const combos = ranges.map((r) => {
      let s = 0;
      for (let i = 0; i < H; i += 1) s += r[i] * combosOfClass(i).length;
      return s;
    }) as [number, number];
    if (combos[0] < minCombos || combos[1] < minCombos) continue;
    const contrib = Math.max(...live.map((p) => tree.contrib[node * tree.players.length + p]));
    out.push({
      line: tree.line[node],
      potType: spec.potType,
      roles: [agg === oop ? "oopAgg" : "oopCaller", agg === ip ? "ipAgg" : "ipCaller"],
      // A candidates range is marked with a "+": "BTN+" is every hand the button continues with.
      positions: [oop, ip].map((p) => tree.players[p] + (tree.players[p] === spec.candidates ? "+" : "")) as [string, string],
      ranges,
      pot: potAt(tree, node),
      stack: tree.stackBb - contrib,
      combos,
    });
  }
  return out;
}

/** Per-combo weights of a class range. */
function comboRange(classes: Float64Array): Float64Array {
  const out = new Float64Array(NUM_COMBOS);
  for (let i = 0; i < H; i += 1) {
    if (classes[i] <= 0) continue;
    for (const c of combosOfClass(i)) out[c] = classes[i];
  }
  return out;
}

/** The seeded deals: four board cards, and `rivers` river cards each if `rivers > 0`. */
export function sampleDeals(count: number, rivers: number, seed: number): { board: number[]; rivers?: number[] }[] {
  const random = mulberry32(seed);
  const out: { board: number[]; rivers?: number[] }[] = [];
  const draw = (taken: number[]) => {
    for (;;) {
      const card = Math.floor(random() * 52);
      if (!taken.includes(card)) return card;
    }
  };
  for (let k = 0; k < count; k += 1) {
    const board: number[] = [];
    while (board.length < 4) board.push(draw(board));
    if (rivers <= 0) {
      out.push({ board });
      continue;
    }
    const river: number[] = [];
    while (river.length < rivers) river.push(draw([...board, ...river]));
    out.push({ board, rivers: river });
  }
  return out;
}

/**
 * Every turn+river solve to run: `spots.length x options.boards` jobs, spot by
 * spot, the same deals for every spot (common random numbers: differences
 * between spots are not board noise).
 */
export function measurementJobs(spots: readonly PreparedSpot[], options: RealisationMeasureOptions): RealisationSpot[] {
  const deals = sampleDeals(options.boards, options.rivers, options.seed);
  const jobs: RealisationSpot[] = [];
  for (const spot of spots) {
    const ranges: [Float64Array, Float64Array] = [comboRange(spot.ranges[0]), comboRange(spot.ranges[1])];
    for (const deal of deals) {
      jobs.push({
        board: deal.board,
        rivers: deal.rivers,
        ranges,
        pot: spot.pot,
        stack: spot.stack,
        firstToAct: 0,
        menu: REALISATION_MENU,
        raiseCap: 2,
        iterations: options.iterations,
      });
    }
  }
  return jobs;
}

/** Sums each spot's samples (in job order). */
export function aggregateSamples(spots: readonly PreparedSpot[], samples: readonly RealisationSample[]): RealisationSample[] {
  const per = samples.length / spots.length;
  return spots.map((_, s) => {
    const agg = emptySample();
    for (let b = 0; b < per; b += 1) addSample(agg, samples[s * per + b]);
    return agg;
  });
}

/* ------------------------------------------------------------------ fit - */

/** Realised shares above this are not representable in the odds form. */
export const MAX_FIT_SHARE = 0.92;
/**
 * A spot's player counts `combos / (combos + RANGE_SHRINK)` in the fit: a
 * calling range of ten combos counts a sixth of a 400-combo defence.
 */
export const RANGE_SHRINK = 50;
/** Ridge penalty on each coefficient, relative to the total fit weight. */
export const RIDGE = 1e-4;

interface FitRow {
  /** Spot index, player. */
  spot: number;
  player: 0 | 1;
  /** `A[i * 169 + j] = m_ij π_q(j) / Σ_j m_ij π_q(j)` for this player's classes. */
  a: Float64Array;
  /** Classes with data, their targets, weights, and table equity against the opponent's range. */
  classes: number[];
  target: number[];
  weight: number[];
  equity: number[];
}

export interface RealisationFitReport {
  potType: PotType;
  spots: string[];
  /** Weighted RMS error of the share, in pot fractions: fitted, charts/1, raw equity (no realisation). */
  rmse: { fitted: number; charts1: number; equity: number };
  /** Range-average realisation `R` per spot and player, measured and as the fitted model has it. */
  average: { line: string; positions: [string, string]; measured: [number, number]; fitted: [number, number] }[];
  /** Position and initiative edges (odds multipliers) for a class of average features. */
  positionEdge: number;
  initiativeEdge: number;
  /**
   * Per hand group and seat (`ip` / `oop`), over every spot: realisation `R`
   * as measured and as fitted (probability-weighted), and the weight behind it.
   */
  groups: { group: string; seat: "ip" | "oop"; measured: number; fitted: number; weight: number }[];
}

/** Hand groups the fit report breaks its error down by. */
export const REPORT_GROUPS: readonly { name: string; test: (c: HandClass) => boolean }[] = [
  { name: "pairs 22-66", test: (c) => c.pair && c.hi <= 4 },
  { name: "pairs 77-JJ", test: (c) => c.pair && c.hi >= 5 && c.hi <= 9 },
  { name: "suited connectors and one-gappers to T9s", test: (c) => c.suited && c.hi - c.lo <= 2 && c.hi <= 8 },
  { name: "suited aces A2s-A9s", test: (c) => c.suited && c.hi === 12 && c.lo <= 7 },
  { name: "suited broadways", test: (c) => c.suited && c.lo >= 8 },
  { name: "offsuit broadways", test: (c) => !c.suited && !c.pair && c.lo >= 8 },
  { name: "offsuit aces A2o-A9o", test: (c) => !c.suited && !c.pair && c.hi === 12 && c.lo <= 7 },
  { name: "other offsuit", test: (c) => !c.suited && !c.pair && c.hi < 12 && c.lo < 8 },
  { name: "other suited", test: (c) => c.suited && c.hi < 12 && c.lo < 8 && c.hi - c.lo > 2 },
];

export interface RealisationFit {
  model: RealisationModel;
  reports: RealisationFitReport[];
}

/** Combo-weighted mean of each feature over all 169 classes (the gauge). */
const FEATURE_MEAN: Float64Array = (() => {
  const out = new Float64Array(NF);
  let total = 0;
  for (let i = 0; i < H; i += 1) {
    const c = combosOfClass(i).length;
    total += c;
    for (let k = 0; k < NF; k += 1) out[k] += c * CLASS_FEATURES[i * NF + k];
  }
  for (let k = 0; k < NF; k += 1) out[k] /= total;
  return out;
})();

/** Log weights of a role from centred coefficients and a bias. */
function logWeights(theta: ArrayLike<number>, offset: number, bias: number, out: Float64Array): void {
  for (let i = 0; i < H; i += 1) {
    let x = bias;
    for (let k = 0; k < NF; k += 1) x += theta[offset + k] * (CLASS_FEATURES[i * NF + k] - FEATURE_MEAN[k]);
    out[i] = Math.exp(x);
  }
}

/** Expected share of each listed class of `w` against `v` through `a` (see FitRow). */
function modelShares(row: FitRow, equity: Float64Array, own: Float64Array, opp: Float64Array, out: number[]): void {
  for (let k = 0; k < row.classes.length; k += 1) {
    const i = row.classes[k];
    let s = 0;
    const wi = own[i];
    for (let j = 0; j < H; j += 1) {
      const a = row.a[i * H + j];
      if (a === 0) continue;
      const e = equity[i * H + j];
      const x = e * wi;
      const y = (1 - e) * opp[j];
      s += a * (x + y > 0 ? x / (x + y) : 0.5);
    }
    out[k] = s;
  }
}

/** Solves `M x = b` in place (Gaussian elimination with partial pivoting). */
function solveLinear(m: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r * n + c]) > Math.abs(m[pivot * n + c])) pivot = r;
    if (pivot !== c) {
      for (let k = 0; k < n; k += 1) {
        const t = m[c * n + k];
        m[c * n + k] = m[pivot * n + k];
        m[pivot * n + k] = t;
      }
      const t = b[c];
      b[c] = b[pivot];
      b[pivot] = t;
    }
    const d = m[c * n + c];
    for (let r = c + 1; r < n; r += 1) {
      const f = m[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k += 1) m[r * n + k] -= f * m[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = b[r];
    for (let k = r + 1; k < n; k += 1) s -= m[r * n + k] * x[k];
    x[r] = s / m[r * n + r];
  }
  return x;
}

/**
 * Parameters per pot type: `[logP, logI, θ_ipAgg, θ_oopAgg, θ_ipCaller,
 * θ_oopCaller]`, θ centred (`FEATURE_MEAN`), so a role's bias is its mean log
 * weight over all classes and the biases are the edges (`roleBiases`).
 */
const ROLE_OFFSET: Record<RealisationRole, number> = {
  ipAgg: 2,
  oopAgg: 2 + NF,
  ipCaller: 2 + 2 * NF,
  oopCaller: 2 + 3 * NF,
};
const NPARAM = 2 + 4 * NF;

function biasOf(params: ArrayLike<number>, role: RealisationRole): number {
  const p = params[0];
  const i = params[1];
  switch (role) {
    case "ipAgg":
      return (p + i) / 2;
    case "oopCaller":
      return -(p + i) / 2;
    case "ipCaller":
      return (p - i) / 2;
    default:
      return -(p - i) / 2;
  }
}

/** Converts fitted (centred) parameters into the model's roles. */
function toRoles(params: ArrayLike<number>): Record<RealisationRole, RoleRealisation> {
  const out = {} as Record<RealisationRole, RoleRealisation>;
  for (const role of REALISATION_ROLES) {
    const off = ROLE_OFFSET[role];
    let bias = biasOf(params, role);
    const coef: Partial<Record<RealisationFeature, number>> = {};
    REALISATION_FEATURES.forEach((f, k) => {
      const c = round(params[off + k], 5);
      coef[f] = c;
      bias -= c * FEATURE_MEAN[k];
    });
    out[role] = { bias: round(bias, 5), coef };
  }
  return out;
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/**
 * Fits one pot type. The two roles in a seat (raiser and caller in
 * position, raiser and caller out of position) share their class
 * coefficients (`tie`); without both raiser-in-position and
 * raiser-out-of-position spots the initiative edge is fixed at 1.
 */
function fitPotType(
  potType: PotType,
  spots: readonly PreparedSpot[],
  samples: readonly RealisationSample[],
  equity: Float64Array,
  start: RealisationModel,
): { params: Float64Array; report: RealisationFitReport } {
  const rows: FitRow[] = [];
  const present = new Set<RealisationRole>();
  spots.forEach((spot, s) => {
    for (const player of [0, 1] as const) {
      present.add(spot.roles[player]);
      const q = 1 - player;
      const own = spot.ranges[player];
      const opp = spot.ranges[q];
      const sample = samples[s];
      const a = new Float64Array(H * H);
      const classes: number[] = [];
      const target: number[] = [];
      const weight: number[] = [];
      const eqs: number[] = [];
      let total = 0;
      for (let i = 0; i < H; i += 1) total += sample.weight[player][i];
      // A range of a few classes says little about a role: shrink its weight.
      total /= spot.combos[player] / (spot.combos[player] + RANGE_SHRINK);
      for (let i = 0; i < H; i += 1) {
        if (own[i] <= 0) continue;
        let mass = 0;
        for (let j = 0; j < H; j += 1) mass += COMPAT[i * H + j] * opp[j];
        if (mass <= 0) continue;
        let e = 0;
        for (let j = 0; j < H; j += 1) {
          const v = (COMPAT[i * H + j] * opp[j]) / mass;
          a[i * H + j] = v;
          e += v * equity[i * H + j];
        }
        const w = sample.weight[player][i];
        const eq = sample.equity[player][i];
        if (w <= 0 || eq <= 0) continue;
        const t = (sample.share[player][i] / eq) * e;
        if (t > MAX_FIT_SHARE) continue;
        classes.push(i);
        target.push(t);
        weight.push(w / total);
        eqs.push(e);
      }
      rows.push({ spot: s, player, a, classes, target, weight, equity: eqs });
    }
  });

  const fitInitiative = present.has("ipAgg") && present.has("oopAgg");
  // One set of class coefficients per position: the raiser's and the
  // caller's in the same seat share them (the caller's ranges are often a
  // handful of classes, too few to fit eleven coefficients on their own).
  const tie: Partial<Record<RealisationRole, RealisationRole>> = {};
  if (present.has("ipAgg") || !present.has("ipCaller")) tie.ipCaller = "ipAgg";
  else tie.ipAgg = "ipCaller";
  if (present.has("oopAgg") || !present.has("oopCaller")) tie.oopCaller = "oopAgg";
  else tie.oopAgg = "oopCaller";

  // Free parameters: logP, logI (if identified), θ of present roles.
  const freeIndex: number[] = [0];
  if (fitInitiative) freeIndex.push(1);
  for (const role of REALISATION_ROLES) {
    if (tie[role]) continue;
    for (let k = 0; k < NF; k += 1) freeIndex.push(ROLE_OFFSET[role] + k);
  }
  const expand = (free: ArrayLike<number>): Float64Array => {
    const p = new Float64Array(NPARAM);
    freeIndex.forEach((idx, k) => {
      p[idx] = free[k];
    });
    for (const role of REALISATION_ROLES) {
      const src = tie[role];
      if (!src) continue;
      for (let k = 0; k < NF; k += 1) p[ROLE_OFFSET[role] + k] = p[ROLE_OFFSET[src] + k];
    }
    return p;
  };

  // Start from the given model, in centred form.
  const init = new Float64Array(NPARAM);
  {
    const roles = start.potTypes[potType];
    const ipAgg = roles.ipAgg.bias;
    const oopCaller = roles.oopCaller.bias;
    const ipCaller = roles.ipCaller.bias;
    const oopAgg = roles.oopAgg.bias;
    const mean = (role: RealisationRole) =>
      REALISATION_FEATURES.reduce((s, f, k) => s + (roles[role].coef[f] ?? 0) * FEATURE_MEAN[k], 0);
    const pi = ipAgg + mean("ipAgg") - (oopCaller + mean("oopCaller"));
    const pmi = ipCaller + mean("ipCaller") - (oopAgg + mean("oopAgg"));
    init[0] = (pi + pmi) / 2;
    init[1] = fitInitiative ? (pi - pmi) / 2 : 0;
    for (const role of REALISATION_ROLES) {
      REALISATION_FEATURES.forEach((f, k) => {
        init[ROLE_OFFSET[role] + k] = roles[role].coef[f] ?? 0;
      });
    }
  }
  let free = Float64Array.from(freeIndex, (idx) => init[idx]);

  const nRes = rows.reduce((s, r) => s + r.classes.length, 0);
  let totalWeight = 0;
  for (const r of rows) for (const w of r.weight) totalWeight += w;
  const ridge = RIDGE * totalWeight;
  const wOwn = new Float64Array(H);
  const wOpp = new Float64Array(H);
  const buf: number[] = new Array(H).fill(0);

  /** Residual vector: sqrt(weight) x (model - target), then ridge rows. */
  const residuals = (freeParams: ArrayLike<number>): Float64Array => {
    const p = expand(freeParams);
    const out = new Float64Array(nRes + freeIndex.length);
    let k = 0;
    for (const row of rows) {
      const spot = spots[row.spot];
      const ownRole = spot.roles[row.player];
      const oppRole = spot.roles[1 - row.player];
      logWeights(p, ROLE_OFFSET[ownRole], biasOf(p, ownRole), wOwn);
      logWeights(p, ROLE_OFFSET[oppRole], biasOf(p, oppRole), wOpp);
      modelShares(row, equity, wOwn, wOpp, buf);
      for (let c = 0; c < row.classes.length; c += 1) {
        out[k] = Math.sqrt(row.weight[c]) * (buf[c] - row.target[c]);
        k += 1;
      }
    }
    // Ridge on the coefficients, not on the edges.
    freeIndex.forEach((idx, f) => {
      out[nRes + f] = idx >= 2 ? Math.sqrt(ridge) * freeParams[f] : 0;
    });
    return out;
  };
  const sumSq = (r: Float64Array) => r.reduce((s, x) => s + x * x, 0);

  // Levenberg-Marquardt with a forward-difference Jacobian.
  const n = freeIndex.length;
  let r = residuals(free);
  let cost = sumSq(r);
  let mu = 1e-3;
  for (let iter = 0; iter < 60; iter += 1) {
    const J = new Float64Array(r.length * n);
    for (let c = 0; c < n; c += 1) {
      const h = 1e-6;
      const shifted = Float64Array.from(free);
      shifted[c] += h;
      const rc = residuals(shifted);
      for (let k = 0; k < r.length; k += 1) J[k * n + c] = (rc[k] - r[k]) / h;
    }
    const jtj = new Float64Array(n * n);
    const jtr = new Float64Array(n);
    for (let k = 0; k < r.length; k += 1) {
      const row = k * n;
      for (let a = 0; a < n; a += 1) {
        const ja = J[row + a];
        if (ja === 0) continue;
        jtr[a] += ja * r[k];
        for (let b = a; b < n; b += 1) jtj[a * n + b] += ja * J[row + b];
      }
    }
    for (let a = 0; a < n; a += 1) for (let b = 0; b < a; b += 1) jtj[a * n + b] = jtj[b * n + a];
    let improved = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const m = Float64Array.from(jtj);
      for (let a = 0; a < n; a += 1) m[a * n + a] += mu * (jtj[a * n + a] + 1e-12);
      const step = solveLinear(m, Float64Array.from(jtr, (x) => -x), n);
      const next = Float64Array.from(free, (x, k) => x + step[k]);
      const rn = residuals(next);
      const cn = sumSq(rn);
      if (cn < cost) {
        const gain = cost - cn;
        free = next;
        r = rn;
        cost = cn;
        mu = Math.max(mu / 3, 1e-9);
        improved = true;
        if (gain < 1e-12 * Math.max(cost, 1e-12)) iter = 1e9;
        break;
      }
      mu *= 4;
    }
    if (!improved) break;
  }
  const params = expand(free);

  // Report: weighted RMS error for the fit, for charts/1, and for raw equity.
  const rmseOf = (weightsFor: (role: RealisationRole) => Float64Array): number => {
    let se = 0;
    let wsum = 0;
    for (const row of rows) {
      const spot = spots[row.spot];
      modelShares(row, equity, weightsFor(spot.roles[row.player]), weightsFor(spot.roles[1 - row.player]), buf);
      for (let c = 0; c < row.classes.length; c += 1) {
        se += row.weight[c] * (buf[c] - row.target[c]) ** 2;
        wsum += row.weight[c];
      }
    }
    return wsum > 0 ? Math.sqrt(se / wsum) : 0;
  };
  const fittedRoles = toRoles(params);
  const fittedModel: RealisationModel = {
    ...CHARTS1_REALISATION,
    potTypes: { ...CHARTS1_REALISATION.potTypes, [potType]: fittedRoles },
  };
  const ones = new Float64Array(H).fill(1);
  const rmse = {
    fitted: round(rmseOf((role) => roleWeights(fittedModel, potType, role)), 5),
    charts1: round(rmseOf((role) => roleWeights(CHARTS1_REALISATION, potType, role)), 5),
    equity: round(rmseOf(() => ones), 5),
  };

  const average = spots.map((spot, s) => {
    const measured: [number, number] = [0, 0];
    const fitted: [number, number] = [0, 0];
    for (const player of [0, 1] as const) {
      const sample = samples[s];
      let sh = 0;
      let eq = 0;
      for (let i = 0; i < H; i += 1) {
        sh += sample.share[player][i];
        eq += sample.equity[player][i];
      }
      measured[player] = round(sh / eq, 4);
      // The model's range-average realisation against the same ranges.
      const own = roleWeights(fittedModel, potType, spot.roles[player]);
      const opp = roleWeights(fittedModel, potType, spot.roles[1 - player]);
      let ms = 0;
      let me = 0;
      for (let i = 0; i < H; i += 1) {
        const ri = spot.ranges[player][i] * combosOfClass(i).length;
        if (ri <= 0) continue;
        for (let j = 0; j < H; j += 1) {
          const rj = spot.ranges[1 - player][j] * COMPAT[i * H + j];
          if (rj <= 0) continue;
          const e = equity[i * H + j];
          const x = e * own[i];
          const y = (1 - e) * opp[j];
          ms += ri * rj * (x / (x + y));
          me += ri * rj * e;
        }
      }
      fitted[player] = round(ms / me, 4);
    }
    return { line: spot.round === undefined ? spot.line : `${spot.line}@${spot.round}`, positions: spot.positions, measured, fitted };
  });

  // Measured and fitted R by hand group and seat.
  const groups: RealisationFitReport["groups"] = [];
  const fittedShares = rows.map((row) => {
    const spot = spots[row.spot];
    const out: number[] = new Array(row.classes.length).fill(0);
    modelShares(
      row,
      equity,
      roleWeights(fittedModel, potType, spot.roles[row.player]),
      roleWeights(fittedModel, potType, spot.roles[1 - row.player]),
      out,
    );
    return out;
  });
  for (const g of REPORT_GROUPS) {
    for (const seat of ["ip", "oop"] as const) {
      let t = 0;
      let f = 0;
      let e = 0;
      let w = 0;
      rows.forEach((row, r) => {
        const isIp = spots[row.spot].roles[row.player].startsWith("ip");
        if (isIp !== (seat === "ip")) return;
        row.classes.forEach((i, c) => {
          if (!g.test(HAND_CLASSES[i])) return;
          t += row.weight[c] * row.target[c];
          f += row.weight[c] * fittedShares[r][c];
          e += row.weight[c] * row.equity[c];
          w += row.weight[c];
        });
      });
      if (w > 0) {
        groups.push({ group: g.name, seat, measured: round(t / e, 3), fitted: round(f / e, 3), weight: round(w, 3) });
      }
    }
  }

  return {
    params,
    report: {
      potType,
      spots: spots.map((s) => (s.round === undefined ? s.line : `${s.line}@${s.round}`)),
      rmse,
      average,
      positionEdge: round(Math.exp(params[0]), 4),
      initiativeEdge: round(Math.exp(params[1]), 4),
      groups,
    },
  };
}

/**
 * Fits a model to measured spots. Pot types without a measured spot keep
 * `start`'s numbers; all-in pots are always neutral.
 */
export function fitRealisation(
  spots: readonly PreparedSpot[],
  samples: readonly RealisationSample[],
  equity: Float64Array,
  start: RealisationModel = CHARTS1_REALISATION,
  name = "charts/2-solver-fit",
): RealisationFit {
  const potTypes = { ...start.potTypes } as Record<PotType, Record<RealisationRole, RoleRealisation>>;
  const reports: RealisationFitReport[] = [];
  for (const potType of POT_TYPES) {
    if (potType === "allin") continue;
    const idx = spots.map((s, k) => (s.potType === potType ? k : -1)).filter((k) => k >= 0);
    if (!idx.length) continue;
    const { params, report } = fitPotType(
      potType,
      idx.map((k) => spots[k]),
      idx.map((k) => samples[k]),
      equity,
      start,
    );
    potTypes[potType] = toRoles(params);
    reports.push(report);
  }
  return {
    model: {
      name,
      source:
        "fitted to turn+river solves (flop checked) of the charts' own heads-up ranges; docs/CHARTS.md §4",
      potTypes,
    },
    reports,
  };
}

/* ------------------------------------------------------------- pipeline - */

export interface RealisedGenerateOptions extends Omit<GenerateOptions, "realisation" | "realisationFit"> {
  /** Measure-and-fit rounds before the final solve. Default `PRODUCTION_ROUNDS`. */
  rounds?: number;
  /** Iterations of the solves whose ranges are measured (the final solve uses `iterations`). */
  roundIterations?: number;
  measure?: Partial<RealisationMeasureOptions>;
  /** The model the first round's solve uses. Default `CHARTS1_REALISATION`. */
  start?: RealisationModel;
  /**
   * Runs turn+river solves. The script runs them on worker threads; the result
   * must be in job order. Default: one after another, here.
   */
  run?: (jobs: RealisationSpot[]) => Promise<RealisationSample[]> | RealisationSample[];
  onRound?: (round: RealisationRound) => void;
}

/** What one round measured and fitted. */
export interface RealisationRound {
  round: number;
  /** Iterations of the solve the ranges came from. */
  iterations: number;
  spots: { line: string; potType: PotType; positions: [string, string]; combos: [number, number] }[];
  jobs: number;
  fit: RealisationFitReport[];
  /** Share of the range that continues: RFI UTG..SB and the BB against a BTN open, under the round's solve. */
  widths: Record<string, number>;
}

export const PRODUCTION_ROUNDS = 3;
export const PRODUCTION_ROUND_ITERATIONS = 1500;

/** Share of the actor's range (combo-weighted) that does not fold at an action node. */
function continueWidth(solver: PreflopSolver, line: string): number {
  const node = solver.tree.lineIndex.get(line);
  if (node === undefined) return NaN;
  const strat = solver.averageStrategy(node);
  const reach = solver.reachAt(node);
  const actor = solver.tree.actor[node];
  let num = 0;
  let den = 0;
  for (let i = 0; i < H; i += 1) {
    const w = combosOfClass(i).length * reach[actor * H + i];
    num += w * (1 - strat[i]);
    den += w;
  }
  return den > 0 ? round(num / den, 4) : NaN;
}

/**
 * The `charts/2` generator: rounds of solve, measure the realisation the
 * charts' own ranges get from the postflop solver, fit; then the final solve
 * with the last fitted model. See the module header.
 */
export async function generateRealisedChartSet(
  options: RealisedGenerateOptions,
): Promise<GenerateResult & { rounds: RealisationRound[] }> {
  const rounds = options.rounds ?? PRODUCTION_ROUNDS;
  const measure: RealisationMeasureOptions = { ...PRODUCTION_MEASURE, ...options.measure };
  const run = options.run ?? ((jobs: RealisationSpot[]) => jobs.map((job) => measureRealisation(job)));
  const start = options.start ?? CHARTS1_REALISATION;
  let model = start;
  let equity = options.equity;
  const history: RealisationRound[] = [];
  // Every round's measurements, pooled: each fit sees every range so far.
  const measuredSpots: PreparedSpot[] = [];
  const measuredSamples: RealisationSample[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const iterations = options.roundIterations ?? PRODUCTION_ROUND_ITERATIONS;
    const solved = generateChartSet({
      ...options,
      equity,
      realisation: model,
      iterations,
      checkEvery: iterations,
      headsUpIterations: 0,
      onProgress: undefined,
    });
    equity = solved.equity;
    const spots = prepareSpots(solved.solver, measure.minClassReach).map((s) => ({ ...s, round }));
    const jobs = measurementJobs(spots, measure);
    const samples = aggregateSamples(spots, await run(jobs));
    measuredSpots.push(...spots);
    measuredSamples.push(...samples);
    const fit = fitRealisation(measuredSpots, measuredSamples, solved.equity.equity, model);
    model = fit.model;
    const widths: Record<string, number> = {};
    for (const [name, line] of [
      ["UTG", ""],
      ["HJ", "f"],
      ["CO", "ff"],
      ["BTN", "fff"],
      ["SB", "ffff"],
      ["BB vs BTN", "fffrf"],
    ] as const) {
      widths[name] = continueWidth(solved.solver, line);
    }
    const entry: RealisationRound = {
      round,
      iterations,
      spots: spots.map((s) => ({
        line: s.line,
        potType: s.potType,
        positions: s.positions,
        combos: [round2(s.combos[0]), round2(s.combos[1])],
      })),
      jobs: jobs.length,
      fit: fit.reports,
      widths,
    };
    history.push(entry);
    options.onRound?.(entry);
  }
  const result = generateChartSet({
    ...options,
    equity,
    realisation: model,
    realisationFit: {
      method:
        "rounds of: solve the preflop game; solve sampled turn+river spots (flop checked) between the charts' heads-up ranges; fit the realisation model's coefficients to the shares realised",
      measure,
      menu: REALISATION_MENU,
      maxFitShare: MAX_FIT_SHARE,
      ridge: RIDGE,
      start: start.name,
      rounds: history,
    },
  });
  return { ...result, rounds: history };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
