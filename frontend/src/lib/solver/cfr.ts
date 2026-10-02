/**
 * Discounted CFR over a public tree, vectorised over private hands.
 *
 * **Algorithm.** Discounted CFR (Brown & Sandholm, "Solving Imperfect-
 * Information Games via Discounted Regret Minimization", AAAI 2019) with
 * alternating updates. On iteration `t` accumulated positive regrets are
 * scaled by `(t-1)^α / ((t-1)^α + 1)`, negative ones by `(t-1)^β / ((t-1)^β + 1)`,
 * and iteration `t`'s strategy enters the average with weight `t^γ`. The
 * defaults `α = 1.5, β = 0, γ = 2` are the paper's recommended DCFR; they
 * converge an order of magnitude faster than vanilla CFR on poker subgames,
 * which is the whole budget of an in-browser river solve.
 *
 * **Vectorised.** Every node carries a vector of values, one per private hand
 * (see `tree.ts`). A traversal for player `p` passes the *opponent's* reach
 * vector down and returns `p`'s counterfactual values up:
 *
 *  - at `p`'s own node: recurse into every action with the same opponent
 *    reach, combine the children by `p`'s strategy, update `p`'s regrets;
 *  - at the opponent's node: split the opponent's reach by its strategy,
 *    recurse, sum - and fold the opponent's reach into its *average* strategy,
 *    since that reach is exactly the opponent's own reach probability there;
 *  - at a chance node: zero the hands that hold the dealt card on both sides,
 *    and weight each outcome by its probability given both hands;
 *  - at a terminal: compute values against the opponent's reach with card
 *    removal, below.
 *
 * **Terminals in O(n + m).** A fold pays a constant times the opponent reach
 * that is compatible with each hand. With per-card sums that is
 * `total - sum[c1] - sum[c2] + reach[same combo]` - inclusion-exclusion, since a
 * hand sharing both cards was subtracted twice. A showdown needs, per hand,
 * the compatible opponent reach that it beats and that beats it: both sides are
 * pre-sorted by strength (`game.ts`), so one ascending and one descending sweep
 * accumulate "everything weaker" and "everything stronger" with the same
 * per-card correction. That is the trick that makes 600-vs-600 combos cheap; the
 * naive double loop is 360,000 compatibility checks per showdown node.
 *
 * **Pruning.** When an opponent action has zero reach for every hand, the
 * traverser's values below it are identically zero, so the subtree is skipped.
 * The only thing skipped with it is the regret discount for that iteration in
 * that subtree, which rescales a node's regrets but does not change the sign
 * pattern regret matching reads. With the average strategy weighted by `t^γ`
 * directly (instead of decaying the sum every iteration) the average is exact
 * under pruning.
 *
 * **No allocation per iteration.** Every buffer is sized once from the tree's
 * depth and widest node: per depth, one slab for the children's values, one
 * for the children's reach and one for the node's strategy. The recursion
 * passes offsets into them instead of `subarray` views, which would allocate.
 *
 * **Turn speed-ups (A5a).** A chance node deals one card per suit class and
 * adds the classes' other cards back through a relabelling of the hands
 * (`game.mirrors`, exact); CFR iterations may walk one stratum of a chance
 * node's cards (`ChanceSampling`, seeded); a player's own node reuses the
 * regret-matched strategy its opponent's traversal just computed there; and
 * `evaluate` records EVs only for the nodes asked for. Showdowns read cards in
 * strength order and skip zero reach.
 *
 * **Deterministic.** Same game, same parameters, same iteration count - same
 * bits. Nothing here reads a clock or a random source, and the summation order
 * is fixed by the input order.
 */

import type { Game } from "./game";
import { ACTION, CHANCE, FOLD, SHOWDOWN, type FlatTree } from "./tree";

export interface DcfrParams {
  alpha: number;
  beta: number;
  gamma: number;
}

/** Brown & Sandholm's recommended DCFR parameters. */
export const DEFAULT_DCFR: Readonly<DcfrParams> = { alpha: 1.5, beta: 0, gamma: 2 };

/**
 * Public chance sampling, stratified (phase A5a). The edges of every chance
 * node that leads to more betting are split into `groups` strata by card
 * (`(rank + suit) mod groups`, so each stratum holds every suit and a spread
 * of ranks); a CFR iteration walks one stratum and scales it by `groups`,
 * which keeps every counterfactual value an unbiased estimate. The strata are
 * visited once per cycle of `groups` iterations, in an order shuffled per
 * cycle by a seeded generator: deterministic, and no river card waits more
 * than two cycles. Best response, evaluation and therefore every reported
 * exploitability always walk every card - the number is exact, not sampled.
 * A chance node whose children are all terminal (an all-in run out) is never
 * sampled: it costs nothing and sampling it would only add noise.
 */
export interface ChanceSampling {
  /** Strata per chance node; 1 disables sampling. */
  groups: number;
  /** Seed of the per-cycle stratum order. */
  seed?: number;
  /** Sample only up to this iteration; every later iteration walks every card. Default: always sample. */
  until?: number;
}

export interface SolverConfig {
  sampling?: ChanceSampling;
}

export interface Exploitability {
  /** Each player's best-response value against the other's average strategy. */
  bestResponse: [number, number];
  /** Each player's value when both play the average strategy. */
  value: [number, number];
  /** `Σ_p bestResponse[p] - value[p]`; zero exactly at a Nash equilibrium. */
  nashConv: number;
  /** `nashConv / 2`: how much a best responder gains, per player on average, in chips. */
  exploitability: number;
  /** `exploitability` as a percentage of `game.pot`. */
  percentPot: number;
  /** `exploitability` in thousandths of a big blind (`game.bigBlind`, default 1 chip). */
  mbb: number;
}

export interface RunOptions {
  /** Stop after this many iterations. Default 1000. */
  maxIterations?: number;
  /** Stop once exploitability is at or below this percentage of the pot. Default 0.3. */
  targetExploitability?: number;
  /** Measure exploitability every this many iterations. Default 10. */
  checkEvery?: number;
  /**
   * First measurement at this iteration (default `checkEvery`). A measurement
   * walks the whole tree three times; on a sampled turn solve that is about
   * ten sampled iterations' work, so measuring long before the solve can be
   * near its target is waste.
   */
  checkFrom?: number;
  /** Called after each measurement. Returning `false` stops the run. */
  onProgress?: (progress: RunProgress) => boolean | void;
}

export interface RunProgress {
  iteration: number;
  exploitability: Exploitability;
}

export interface RunResult {
  iterations: number;
  exploitability: Exploitability;
  stoppedBy: "target" | "max-iterations" | "cancelled";
}

const MODE_CFR = 0;
const MODE_BEST = 1;
const MODE_EVAL = 2;

export class Solver {
  readonly game: Game;
  readonly params: DcfrParams;
  /** Per node: where its `actions x hands` block starts in `regrets` and friends. */
  readonly offset: Int32Array;
  /** Cumulative discounted regrets, `[node block][action][hand]`. */
  readonly regrets: Float32Array;
  /**
   * Each node's current (regret-matched) strategy as last computed at it as
   * the opponent's node, and the traversal that computed it (`stamp`). The
   * player's own next traversal reads it back instead of matching again: the
   * regrets have not moved in between. Halves the regret matching, which was
   * a sixth of a solve.
   */
  private readonly current: Float32Array;
  private readonly currentStamp: Int32Array;
  /** Counts traversals: `2 * iteration + traverser` during CFR. */
  private stamp = 0;
  /** Cumulative `t^γ`-weighted strategy, same layout. */
  readonly strategySum: Float32Array;
  /**
   * Counterfactual EV per action per hand from the last `evaluate()`, laid out
   * like `regrets` but only for the nodes it recorded: node `x`'s block starts
   * at `evOffset[x]`, -1 for a node it skipped.
   */
  ev: Float32Array | null = null;
  evOffset: Int32Array | null = null;
  /** Iterations run so far. */
  iterations = 0;

  private readonly tree: FlatTree;
  private readonly n: [number, number];
  /** `same[p][i]`: the opponent's hand with exactly the cards of `p`'s hand `i`, or -1. */
  private readonly same: [Int32Array, Int32Array];
  /** `Σ_i Σ_j w0[i] w1[j] [compatible]`: the probability mass of all deals. */
  readonly normalizer: number;
  /** Sum of both players' payoffs if it is the same at every terminal (no rake), else NaN. */
  private readonly constantSum: number;

  /** Per showdown board, per player: cards and same-combo index in strength order. */
  private readonly sorted: {
    c1: [Uint8Array, Uint8Array];
    c2: [Uint8Array, Uint8Array];
    same: [Int32Array, Int32Array];
  }[];

  private readonly cfvBuf: Float64Array[] = [];
  private readonly reachBuf: Float64Array[] = [];
  private readonly stratBuf: Float64Array[] = [];
  private readonly cardSum: Float64Array;
  private readonly cardSum2: Float64Array;
  private readonly winBuf: Float64Array;
  private readonly normBuf: Float64Array;
  private readonly sumBuf: Float64Array;
  private readonly rootOut: Float64Array;

  /** Sampling: strata per chance node (1 = off), each edge's stratum, which chance nodes are sampled. */
  private readonly groups: number;
  private readonly edgeGroup: Uint8Array;
  private readonly sampledChance: Uint8Array;
  private readonly rng: () => number;
  private readonly sampleUntil: number;
  private cycle: number[] = [];
  private group = -1;
  private sampling = false;

  private trav = 0;
  private mode = MODE_CFR;
  private recordEv = false;
  private dPos = 0;
  private dNeg = 0;
  private wStrat = 1;

  constructor(game: Game, params: Partial<DcfrParams> = {}, config: SolverConfig = {}) {
    this.game = game;
    this.params = { ...DEFAULT_DCFR, ...params };
    this.tree = game.tree;
    const tree = game.tree;
    this.n = [game.hands[0].size, game.hands[1].size];

    const offset = new Int32Array(tree.size).fill(-1);
    let total = 0;
    let maxActions = 1;
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] === ACTION) {
        offset[node] = total;
        total += tree.childCount[node] * this.n[tree.player[node]];
        maxActions = Math.max(maxActions, tree.childCount[node]);
      }
    }
    this.offset = offset;
    this.regrets = new Float32Array(total);
    this.current = new Float32Array(total);
    this.currentStamp = new Int32Array(tree.size).fill(-2);
    this.strategySum = new Float32Array(total);

    // A chance node walks its children one at a time through a single slice,
    // so only action nodes set the width; sizing by the 48-card deal would
    // multiply every depth's scratch tenfold for nothing.
    const maxHands = Math.max(this.n[0], this.n[1], 1);
    const slab = maxActions * maxHands;
    for (let d = 0; d <= tree.maxDepth; d += 1) {
      this.cfvBuf.push(new Float64Array(slab));
      this.reachBuf.push(new Float64Array(slab));
      this.stratBuf.push(new Float64Array(slab));
    }
    this.cardSum = new Float64Array(game.numCards + 2);
    this.cardSum2 = new Float64Array(game.numCards + 2);
    this.winBuf = new Float64Array(maxHands);
    this.normBuf = new Float64Array(maxHands);
    this.sumBuf = new Float64Array(maxHands);
    this.rootOut = new Float64Array(maxHands);

    this.same = [sameIndex(game, 0), sameIndex(game, 1)];
    this.sorted = game.boards.map((board) => {
      const side = (p: number) => {
        const order = board.order[p];
        const hands = game.hands[p];
        return {
          c1: Uint8Array.from(order, (i) => hands.c1[i]),
          c2: Uint8Array.from(order, (i) => hands.c2[i]),
          same: Int32Array.from(order, (i) => this.same[p][i]),
        };
      };
      const s0 = side(0);
      const s1 = side(1);
      return { c1: [s0.c1, s1.c1], c2: [s0.c2, s1.c2], same: [s0.same, s1.same] };
    });

    // Probability mass of all deals: Σ_i w0[i] * (compatible w1 reach of i).
    this.trav = 0;
    this.compat(game.hands[1].weight, 0, this.rootOut, 0, 1);
    let norm = 0;
    for (let i = 0; i < this.n[0]; i += 1) {
      norm += game.hands[0].weight[i] * this.rootOut[i];
    }
    this.normalizer = norm;
    this.constantSum = constantSum(tree);

    // Chance sampling strata.
    this.groups = Math.max(1, Math.min(16, Math.floor(config.sampling?.groups ?? 1)));
    this.edgeGroup = new Uint8Array(tree.children.length);
    this.sampledChance = new Uint8Array(tree.size);
    this.rng = mulberry32(config.sampling?.seed ?? 0x5a17);
    this.sampleUntil = config.sampling?.until ?? Infinity;
    if (this.groups > 1) {
      for (let node = 0; node < tree.size; node += 1) {
        if (tree.type[node] !== CHANCE) {
          continue;
        }
        const start = tree.childStart[node];
        const end = start + tree.childCount[node];
        let deeper = false;
        for (let e = start; e < end; e += 1) {
          const child = tree.children[e];
          if (tree.type[child] === ACTION || tree.type[child] === CHANCE) {
            deeper = true;
          }
          const card = tree.edgeCard[e];
          this.edgeGroup[e] = card >= 0 ? ((card >> 2) + (card & 3)) % this.groups : (e - start) % this.groups;
        }
        this.sampledChance[node] = deeper ? 1 : 0;
      }
    }
  }

  /** Strata per chance node this solver samples with; 1 when it does not sample. */
  get samplingGroups(): number {
    return this.groups;
  }

  /** Total bytes held in typed arrays for this solve. */
  get bytes(): number {
    let scratch = 0;
    for (let d = 0; d < this.cfvBuf.length; d += 1) {
      scratch += this.cfvBuf[d].byteLength * 3;
    }
    return (
      this.regrets.byteLength +
      this.strategySum.byteLength +
      this.current.byteLength +
      this.currentStamp.byteLength +
      (this.ev?.byteLength ?? 0) +
      (this.evOffset?.byteLength ?? 0) +
      this.offset.byteLength +
      scratch
    );
  }

  /** Runs `count` DCFR iterations (each updates both players once). */
  iterate(count = 1): void {
    const { alpha, beta, gamma } = this.params;
    const tree = this.tree;
    for (let k = 0; k < count; k += 1) {
      const t = ++this.iterations;
      const pa = Math.pow(t - 1, alpha);
      const pb = Math.pow(t - 1, beta);
      this.dPos = pa / (pa + 1);
      this.dNeg = pb / (pb + 1);
      this.wStrat = Math.pow(t, gamma);
      this.mode = MODE_CFR;
      this.sampling = this.groups > 1 && t <= this.sampleUntil;
      if (this.sampling) {
        if (this.cycle.length === 0) {
          this.cycle = shuffled(this.groups, this.rng);
        }
        this.group = this.cycle.pop() as number;
      }
      for (let p = 0; p < 2; p += 1) {
        this.trav = p;
        this.stamp = 2 * t + p;
        this.walk(tree.root, 0, this.game.hands[1 - p].weight, 0, this.rootOut, 0);
      }
    }
  }

  /**
   * Iterates until the exploitability target, the iteration cap, or a
   * cancelling `onProgress`. Exploitability is measured every `checkEvery`
   * iterations and once more at the end, so the result always carries a
   * measured number.
   */
  run(options: RunOptions = {}): RunResult {
    const max = options.maxIterations ?? 1000;
    const target = options.targetExploitability ?? 0.3;
    const every = Math.max(1, options.checkEvery ?? 10);
    const from = Math.max(1, options.checkFrom ?? every);
    let measured: Exploitability | null = null;
    while (this.iterations < max) {
      const next = this.iterations < from ? from : this.iterations + every;
      const step = Math.min(next - this.iterations, max - this.iterations);
      this.iterate(step);
      measured = this.exploitability();
      const keepGoing = options.onProgress?.({ iteration: this.iterations, exploitability: measured });
      if (measured.percentPot <= target) {
        return { iterations: this.iterations, exploitability: measured, stoppedBy: "target" };
      }
      if (keepGoing === false) {
        return { iterations: this.iterations, exploitability: measured, stoppedBy: "cancelled" };
      }
    }
    measured ??= this.exploitability();
    return {
      iterations: this.iterations,
      exploitability: measured,
      stoppedBy: measured.percentPot <= target ? "target" : "max-iterations",
    };
  }

  /** Best response and profile values for the current average strategy. */
  exploitability(): Exploitability {
    const br: [number, number] = [this.rootValue(0, MODE_BEST), this.rootValue(1, MODE_BEST)];
    let value: [number, number];
    if (Number.isNaN(this.constantSum)) {
      value = [this.rootValue(0, MODE_EVAL), this.rootValue(1, MODE_EVAL)];
    } else {
      // Constant-sum: one evaluation pass gives both values.
      const v0 = this.rootValue(0, MODE_EVAL);
      value = [v0, this.constantSum - v0];
    }
    const nashConv = br[0] - value[0] + (br[1] - value[1]);
    const exploitability = nashConv / 2;
    return {
      bestResponse: br,
      value,
      nashConv,
      exploitability,
      percentPot: (100 * exploitability) / this.game.pot,
      mbb: (1000 * exploitability) / (this.game.bigBlind ?? 1),
    };
  }

  /**
   * Values of the average profile, recording per-action EVs at every node into
   * `this.ev`, and each player's EV per hand at the root.
   *
   * An EV is `counterfactual value / compatible opponent reach`: the player's
   * expected net chips from the start of the game, given that this hand is
   * at this node and play continues by the average strategy. Comparing two
   * actions' EVs for the same hand is what EV loss is.
   */
  evaluate(record?: (node: number) => boolean): { value: [number, number]; rootEv: [Float64Array, Float64Array] } {
    const tree = this.tree;
    const evOffset = new Int32Array(tree.size).fill(-1);
    let total = 0;
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] === ACTION && (!record || record(node))) {
        evOffset[node] = total;
        total += tree.childCount[node] * this.n[tree.player[node]];
      }
    }
    this.evOffset = evOffset;
    this.ev = new Float32Array(total);
    this.recordEv = true;
    const value: [number, number] = [0, 0];
    const rootEv: [Float64Array, Float64Array] = [new Float64Array(this.n[0]), new Float64Array(this.n[1])];
    try {
      for (let p = 0; p < 2; p += 1) {
        value[p] = this.rootValue(p, MODE_EVAL);
        this.trav = p;
        const cfv = Float64Array.from(this.rootOut.subarray(0, this.n[p]));
        this.compat(this.game.hands[1 - p].weight, 0, this.normBuf, 0, 1);
        for (let i = 0; i < this.n[p]; i += 1) {
          rootEv[p][i] = this.normBuf[i] > 0 ? cfv[i] / this.normBuf[i] : 0;
        }
      }
    } finally {
      this.recordEv = false;
    }
    return { value, rootEv };
  }

  /** Average strategy at an action node as `[action][hand]`, rows summing to 1. */
  averageStrategy(node: number): Float32Array {
    const tree = this.tree;
    if (tree.type[node] !== ACTION) {
      throw new Error(`node ${node} is not an action node`);
    }
    const count = tree.childCount[node];
    const size = this.n[tree.player[node]];
    const strat = this.stratBuf[0];
    this.average(this.offset[node], count, size, strat);
    return Float32Array.from(strat.subarray(0, count * size));
  }

  /**
   * Replaces the average strategy at a node. For tests that need a best
   * response against a given strategy, not a solved one.
   */
  setAverageStrategy(node: number, strategy: ArrayLike<number>): void {
    const off = this.offset[node];
    const len = this.tree.childCount[node] * this.n[this.tree.player[node]];
    for (let k = 0; k < len; k += 1) {
      this.strategySum[off + k] = strategy[k];
    }
  }

  /** Root value for player `p` in `mode`, normalised to an expectation over deals. */
  private rootValue(p: number, mode: number): number {
    this.trav = p;
    this.mode = mode;
    this.walk(this.tree.root, 0, this.game.hands[1 - p].weight, 0, this.rootOut, 0);
    const w = this.game.hands[p].weight;
    let sum = 0;
    for (let i = 0; i < this.n[p]; i += 1) {
      sum += w[i] * this.rootOut[i];
    }
    return sum / this.normalizer;
  }

  /* ------------------------------------------------------------ walk - */

  private walk(
    node: number,
    depth: number,
    reach: Float64Array,
    rOff: number,
    out: Float64Array,
    oOff: number,
  ): void {
    const tree = this.tree;
    const type = tree.type[node];
    if (type === FOLD) {
      this.compat(reach, rOff, out, oOff, tree.payoff[node * 6 + this.trav * 3]);
      return;
    }
    if (type === SHOWDOWN) {
      this.showdown(node, reach, rOff, out, oOff);
      return;
    }
    if (type === CHANCE) {
      this.chance(node, depth, reach, rOff, out, oOff);
      return;
    }

    const p = this.trav;
    const n = this.n[p];
    const m = this.n[1 - p];
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    const off = this.offset[node];
    const cfv = this.cfvBuf[depth];
    const strat = this.stratBuf[depth];
    const mode = this.mode;

    if (tree.player[node] === p) {
      for (let a = 0; a < count; a += 1) {
        this.walk(tree.children[start + a], depth + 1, reach, rOff, cfv, a * n);
      }
      if (mode === MODE_BEST) {
        for (let i = 0; i < n; i += 1) {
          let best = cfv[i];
          for (let a = 1; a < count; a += 1) {
            const v = cfv[a * n + i];
            if (v > best) {
              best = v;
            }
          }
          out[oOff + i] = best;
        }
        return;
      }
      if (mode === MODE_CFR) {
        // The regrets here last changed in this player's previous traversal;
        // the opponent's traversal since computed this very strategy.
        if (this.currentStamp[node] === this.stamp - 1) {
          const current = this.current;
          for (let k = 0; k < count * n; k += 1) {
            strat[k] = current[off + k];
          }
        } else {
          this.regretMatch(off, count, n, strat);
        }
      } else {
        this.average(off, count, n, strat);
      }
      for (let i = 0; i < n; i += 1) {
        out[oOff + i] = strat[i] * cfv[i];
      }
      for (let a = 1; a < count; a += 1) {
        const base = a * n;
        for (let i = 0; i < n; i += 1) {
          out[oOff + i] += strat[base + i] * cfv[base + i];
        }
      }
      if (mode === MODE_CFR) {
        const regrets = this.regrets;
        const dPos = this.dPos;
        const dNeg = this.dNeg;
        for (let a = 0; a < count; a += 1) {
          const base = a * n;
          const r0 = off + base;
          for (let i = 0; i < n; i += 1) {
            const r = regrets[r0 + i];
            regrets[r0 + i] = (r > 0 ? r * dPos : r * dNeg) + cfv[base + i] - out[oOff + i];
          }
        }
      } else if (this.recordEv && (this.evOffset as Int32Array)[node] >= 0) {
        const ev = this.ev as Float32Array;
        const evOff = (this.evOffset as Int32Array)[node];
        const norm = this.normBuf;
        this.compat(reach, rOff, norm, 0, 1);
        for (let a = 0; a < count; a += 1) {
          const base = a * n;
          for (let i = 0; i < n; i += 1) {
            ev[evOff + base + i] = norm[i] > 0 ? cfv[base + i] / norm[i] : 0;
          }
        }
      }
      return;
    }

    // Opponent's node.
    if (mode === MODE_CFR) {
      this.regretMatch(off, count, m, strat);
      // Kept for this player's own next traversal (see above).
      const current = this.current;
      for (let k = 0; k < count * m; k += 1) {
        current[off + k] = strat[k];
      }
      this.currentStamp[node] = this.stamp;
      const sum = this.strategySum;
      const w = this.wStrat;
      for (let a = 0; a < count; a += 1) {
        const base = a * m;
        const s0 = off + base;
        for (let j = 0; j < m; j += 1) {
          sum[s0 + j] += w * reach[rOff + j] * strat[base + j];
        }
      }
    } else {
      this.average(off, count, m, strat);
    }
    const childReach = this.reachBuf[depth];
    out.fill(0, oOff, oOff + n);
    for (let a = 0; a < count; a += 1) {
      const base = a * m;
      let any = 0;
      for (let j = 0; j < m; j += 1) {
        const v = reach[rOff + j] * strat[base + j];
        childReach[base + j] = v;
        any += v;
      }
      if (any === 0) {
        continue;
      }
      this.walk(tree.children[start + a], depth + 1, childReach, base, cfv, a * n);
      const cBase = a * n;
      for (let i = 0; i < n; i += 1) {
        out[oOff + i] += cfv[cBase + i];
      }
    }
  }

  private chance(
    node: number,
    depth: number,
    reach: Float64Array,
    rOff: number,
    out: Float64Array,
    oOff: number,
  ): void {
    const tree = this.tree;
    const p = this.trav;
    const n = this.n[p];
    const m = this.n[1 - p];
    const mine = this.game.hands[p];
    const theirs = this.game.hands[1 - p];
    const pc1 = mine.c1;
    const pc2 = mine.c2;
    const oc1 = theirs.c1;
    const oc2 = theirs.c2;
    const mirrors = this.game.mirrors;
    const sample = this.mode === MODE_CFR && this.sampling && this.sampledChance[node] === 1;
    const group = this.group;
    const w = tree.chanceWeight[node] * (sample ? this.groups : 1);
    const childReach = this.reachBuf[depth];
    const cfv = this.cfvBuf[depth];
    out.fill(0, oOff, oOff + n);
    const end = tree.childStart[node] + tree.childCount[node];
    for (let e = tree.childStart[node]; e < end; e += 1) {
      if (sample && this.edgeGroup[e] !== group) {
        continue;
      }
      const card = tree.edgeCard[e];
      let any = 0;
      for (let j = 0; j < m; j += 1) {
        const v = oc1[j] === card || oc2[j] === card ? 0 : reach[rOff + j];
        childReach[j] = v;
        any += v;
      }
      if (any === 0) {
        continue;
      }
      this.walk(tree.children[e], depth + 1, childReach, 0, cfv, 0);
      for (let i = 0; i < n; i += 1) {
        if (pc1[i] !== card && pc2[i] !== card) {
          out[oOff + i] += w * cfv[i];
        }
      }
      // Suit isomorphism (`game.mirrors`): each card this one stands for is
      // the same subtree with the hands relabelled, so its values are these
      // values read through the relabelling.
      const twins = mirrors?.[card];
      if (twins) {
        for (let k = 0; k < twins.length; k += 1) {
          const other = twins[k].card;
          const map = twins[k].map[p];
          for (let i = 0; i < n; i += 1) {
            if (pc1[i] !== other && pc2[i] !== other) {
              out[oOff + i] += w * cfv[map[i]];
            }
          }
        }
      }
    }
  }

  /** `out[i] = scale * (opponent reach compatible with the traverser's hand i)`. */
  private compat(reach: Float64Array, rOff: number, out: Float64Array, oOff: number, scale: number): void {
    const p = this.trav;
    const mine = this.game.hands[p];
    const theirs = this.game.hands[1 - p];
    const n = this.n[p];
    const m = this.n[1 - p];
    const oc1 = theirs.c1;
    const oc2 = theirs.c2;
    const pc1 = mine.c1;
    const pc2 = mine.c2;
    const cs = this.cardSum;
    const same = this.same[p];
    cs.fill(0);
    let total = 0;
    for (let j = 0; j < m; j += 1) {
      const v = reach[rOff + j];
      if (v !== 0) {
        total += v;
        cs[oc1[j]] += v;
        cs[oc2[j]] += v;
      }
    }
    for (let i = 0; i < n; i += 1) {
      const s = same[i];
      const back = s >= 0 ? reach[rOff + s] : 0;
      out[oOff + i] = scale * (total - cs[pc1[i]] - cs[pc2[i]] + back);
    }
  }

  private showdown(node: number, reach: Float64Array, rOff: number, out: Float64Array, oOff: number): void {
    const tree = this.tree;
    const p = this.trav;
    const o = 1 - p;
    const n = this.n[p];
    const boardId = tree.board[node];
    const board = this.game.boards[boardId];
    const sorted = this.sorted[boardId];
    // Cards in strength order, so the sweeps read them sequentially.
    const pc1 = sorted.c1[p];
    const pc2 = sorted.c2[p];
    const psame = sorted.same[p];
    const oc1 = sorted.c1[o];
    const oc2 = sorted.c2[o];
    const ordP = board.order[p];
    const strP = board.strength[p];
    const ordO = board.order[o];
    const strO = board.strength[o];
    const nv = ordP.length;
    const mv = ordO.length;
    const base = node * 6 + p * 3;
    const win = tree.payoff[base];
    const lose = tree.payoff[base + 1];
    const tie = tree.payoff[base + 2];

    // Hands impossible on this board are absent from `ordP`; they score zero.
    if (nv < n) {
      out.fill(0, oOff, oOff + n);
    }

    // Ascending: compatible opponent reach strictly weaker than each hand.
    // Running the sweep on to the end leaves the totals - all opponent reach,
    // and per card - in `cum` / `cs`, which saves a separate pass. Zero reach
    // (a hand the opponent's strategy took elsewhere) adds nothing and is skipped.
    const wins = this.winBuf;
    const cs = this.cardSum;
    cs.fill(0);
    let cum = 0;
    let k = 0;
    for (let t = 0; t < nv; t += 1) {
      const s = strP[t];
      while (k < mv && strO[k] < s) {
        const v = reach[rOff + ordO[k]];
        if (v !== 0) {
          cum += v;
          cs[oc1[k]] += v;
          cs[oc2[k]] += v;
        }
        k += 1;
      }
      wins[t] = cum - cs[pc1[t]] - cs[pc2[t]];
    }
    for (; k < mv; k += 1) {
      const v = reach[rOff + ordO[k]];
      if (v !== 0) {
        cum += v;
        cs[oc1[k]] += v;
        cs[oc2[k]] += v;
      }
    }
    const total = cum;

    // Descending: strictly stronger; then combine.
    const acc = this.cardSum2;
    acc.fill(0);
    cum = 0;
    k = mv - 1;
    const winMinusLose = win - lose;
    const tieMinusLose = tie - lose;
    for (let t = nv - 1; t >= 0; t -= 1) {
      const s = strP[t];
      while (k >= 0 && strO[k] > s) {
        const v = reach[rOff + ordO[k]];
        if (v !== 0) {
          cum += v;
          acc[oc1[k]] += v;
          acc[oc2[k]] += v;
        }
        k -= 1;
      }
      const a = pc1[t];
      const b = pc2[t];
      const losses = cum - acc[a] - acc[b];
      const sm = psame[t];
      const all = total - cs[a] - cs[b] + (sm >= 0 ? reach[rOff + sm] : 0);
      const w = wins[t];
      out[oOff + ordP[t]] = lose * all + winMinusLose * w + tieMinusLose * (all - w - losses);
    }
  }

  /* ------------------------------------------------------- strategies - */

  /** Regret matching: strategy proportional to positive regret, uniform if none. */
  private regretMatch(off: number, count: number, size: number, strat: Float64Array): void {
    const regrets = this.regrets;
    const sum = this.sumBuf;
    sum.fill(0, 0, size);
    for (let a = 0; a < count; a += 1) {
      const r0 = off + a * size;
      for (let i = 0; i < size; i += 1) {
        const r = regrets[r0 + i];
        if (r > 0) {
          sum[i] += r;
        }
      }
    }
    const uniform = 1 / count;
    for (let a = 0; a < count; a += 1) {
      const base = a * size;
      const r0 = off + base;
      for (let i = 0; i < size; i += 1) {
        const r = regrets[r0 + i];
        const s = sum[i];
        strat[base + i] = s > 0 ? (r > 0 ? r / s : 0) : uniform;
      }
    }
  }

  /** Normalised average strategy, uniform where a hand never reached the node. */
  private average(off: number, count: number, size: number, strat: Float64Array): void {
    const sums = this.strategySum;
    const sum = this.sumBuf;
    sum.fill(0, 0, size);
    for (let a = 0; a < count; a += 1) {
      const r0 = off + a * size;
      for (let i = 0; i < size; i += 1) {
        sum[i] += sums[r0 + i];
      }
    }
    const uniform = 1 / count;
    for (let a = 0; a < count; a += 1) {
      const base = a * size;
      const r0 = off + base;
      for (let i = 0; i < size; i += 1) {
        const s = sum[i];
        strat[base + i] = s > 0 ? sums[r0 + i] / s : uniform;
      }
    }
  }
}

/** A seeded 32-bit generator (mulberry32): the sampling order, reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `0 .. count - 1` in a seeded random order (Fisher-Yates). */
function shuffled(count: number, rng: () => number): number[] {
  const out = Array.from({ length: count }, (_, k) => k);
  for (let k = count - 1; k > 0; k -= 1) {
    const j = Math.floor(rng() * (k + 1));
    const swap = out[k];
    out[k] = out[j];
    out[j] = swap;
  }
  return out;
}

/** For each of `p`'s hands, the opponent's hand with the same two cards, or -1. */
function sameIndex(game: Game, p: number): Int32Array {
  const mine = game.hands[p];
  const theirs = game.hands[1 - p];
  const key = (a: number, b: number) => (a < b ? a * 64 + b : b * 64 + a);
  const lookup = new Map<number, number>();
  for (let j = 0; j < theirs.size; j += 1) {
    lookup.set(key(theirs.c1[j], theirs.c2[j]), j);
  }
  const out = new Int32Array(mine.size);
  for (let i = 0; i < mine.size; i += 1) {
    out[i] = lookup.get(key(mine.c1[i], mine.c2[i])) ?? -1;
  }
  return out;
}

/**
 * `u0 + u1` if it is the same at every terminal, else NaN. Without rake a
 * poker subgame is constant-sum (the pot is only moved), and then one
 * evaluation pass yields both players' values.
 */
function constantSum(tree: FlatTree): number {
  let value = NaN;
  const same = (x: number) => {
    if (Number.isNaN(value)) {
      value = x;
      return true;
    }
    return Math.abs(x - value) <= 1e-9 * Math.max(1, Math.abs(value));
  };
  for (let node = 0; node < tree.size; node += 1) {
    const b = node * 6;
    const pay = tree.payoff;
    if (tree.type[node] === FOLD) {
      if (!same(pay[b] + pay[b + 3])) {
        return NaN;
      }
    } else if (tree.type[node] === SHOWDOWN) {
      if (!same(pay[b] + pay[b + 4]) || !same(pay[b + 1] + pay[b + 3]) || !same(pay[b + 2] + pay[b + 5])) {
        return NaN;
      }
    }
  }
  return value;
}
