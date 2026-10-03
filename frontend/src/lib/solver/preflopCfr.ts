/**
 * Discounted CFR for the multi-player preflop game.
 *
 * Same algorithm as `cfr.ts` (DCFR, Brown & Sandholm 2019, alternating
 * updates, `α = 1.5, β = 0, γ = 2`) and the same "public tree, private
 * vectors" shape, but for up to six players whose private hands are the 169
 * classes (`handClasses.ts`). `cfr.ts` is left untouched: it is the heads-up
 * engine with exact card removal over combos, which the postflop solver needs;
 * this one trades exactness between opponents for the ability to have six of
 * them.
 *
 * **The probability model.** Given the traverser's class `i`, each opponent's
 * class is drawn independently with `P(j | i) = m[i][j] / 1225`: card removal
 * between the hero and each opponent is exact at the class level, card removal
 * *between two opponents* is ignored. A counterfactual value is then
 *
 *     v_p(i) = Π_{q ≠ p} [Σ_j P(j | i) π_q(j)] x (payoff given the opponents'
 *              ranges at the terminal)
 *
 * which for a fold is `(won or lost) x Π_q R_q(i)` with `R_q = massVector(π_q)`,
 * and for a pot that sees a flop is `preflopModel.ts`'s realised share, per
 * opponent class, through the pre-built share matrices. Every payoff is
 * multilinear in the opponents' reach, so this is an ordinary extensive-form
 * game and best responses and NashConv mean what they usually mean.
 *
 * **No equilibrium guarantee.** CFR converges to a Nash equilibrium in
 * two-player zero-sum games. With three or more players (or with rake, which
 * makes even two players general-sum) its average strategy converges to a
 * coarse correlated equilibrium at best, and nothing promises a Nash
 * equilibrium. What *can* be measured is how far the result is from one:
 * `exploitability()` computes each player's best-response gain against the
 * others' average strategies - NashConv, the sum of those gains, is zero
 * exactly at a Nash equilibrium of this model. The chart generator reports it.
 *
 * **Pruning.** A traversal for player `p` stops where `p` folds: everything
 * below is the same `-contribution` for `p`, weighted by the opponents' reach
 * at that point (their strategies below sum to one). Opponent actions with no
 * reach for any hand are skipped as in `cfr.ts`. Share matrices are applied
 * column by column from their transpose, skipping opponent classes with zero
 * reach, so narrow 4-bet and 5-bet ranges cost a fraction of a full product.
 *
 * **Trembling limps** (`limpFloor`, A2d). A tree with open limps
 * (`maxLimpers`) has nodes behind a limp that the equilibrium may never reach:
 * if no seat but the small blind ever limps, nobody's strategy facing a limp
 * is trained - CFR weights a player's regrets by the opponents' reach, and the
 * limper's is zero. So the game is **perturbed** (Selten's trembling hand; the
 * ε-perturbed games of Farina, Kroer and Sandholm): at every unopened decision
 * of a seat other than the blinds, every class limps with probability at
 * least `ε`, `y = (1 - ε)·x + ε·e_limp`. Regret matching runs on the free
 * part `x` (the regrets use `x`'s value as the baseline, the strategy sum
 * averages `x`), and the game is played with `y` - in every traversal, the
 * best response, the evaluation and `averageStrategy`. The best response is
 * the perturbed game's (`(1 - ε)·max + ε·limp`), so NashConv is measured in
 * the game that is solved. A limper's range behind a limp is then its
 * equilibrium limps plus `ε` of every class - "a limper may hold anything" -
 * and its own later decisions (facing an isolation raise) are trained for
 * every class, as any player's are.
 *
 * **Deterministic.** No clock, no random source, a fixed summation order.
 */

import { DEFAULT_DCFR, type DcfrParams } from "./cfr";
import { CLASS_COMBOS, independentMass, massVector, NUM_CLASSES } from "./handClasses";
import { NUM_COMBOS } from "./combos";
import {
  CHARTS1_REALISATION,
  flopRake,
  realisationRole,
  roleWeights,
  shareMatrix,
  type PotType,
  type RakeProfile,
  type RealisationModel,
  type RealisationRole,
} from "./preflopModel";
import { PF_ACTION, PF_FOLD, POSTFLOP_ORDER, POT_TYPE_INDEX, type PreflopTree } from "./preflopTree";

const H = NUM_CLASSES;

export interface PreflopGame {
  tree: PreflopTree;
  /** 169x169 heads-up equity (`preflopEquity.ts`). */
  equity: Float64Array;
  rake: Readonly<RakeProfile>;
  /** Card removal between the hero and each opponent (default true). */
  cardRemoval?: boolean;
  /** How a pot that sees a flop is shared (default: `CHARTS1_REALISATION`). */
  realisation?: RealisationModel;
  /**
   * The open limp's tremble (`charts/4`, A2d; 0 or absent: none): at every
   * unopened decision of a seat other than the blinds, every class limps at
   * least this often. See "Trembling limps" in the header.
   */
  limpFloor?: number;
}

export interface PreflopExploitability {
  /** Per player: value of a best response against the others' average strategies (bb/hand). */
  bestResponse: number[];
  /** Per player: value when everyone plays the average strategy (bb/hand). */
  value: number[];
  /** Per player: `bestResponse - value`, in mbb/hand. */
  gainMbb: number[];
  /** Σ gains in mbb/hand: zero exactly at a Nash equilibrium of the model. */
  nashConvMbb: number;
  /** Σ values: minus the expected rake per hand, in bb. */
  valueSum: number;
}

const MODE_CFR = 0;
const MODE_BEST = 1;
const MODE_EVAL = 2;

/** Per terminal: what the walk needs, precomputed. */
interface Terminal {
  kind: number;
  /** Live players. */
  live: number[];
  /** Per player: net chips if this player wins the whole pot / gets its share. */
  pot: number;
  /** Pot less rake. */
  net: number;
  /** For live players a and b: share matrix (transposed) of a against b; `null` on the diagonal. */
  share: (Float64Array | null)[][];
  /**
   * Multiway pots: `S_ab π_b` per ordered pair (`[a * n + b]`) and the mass
   * `R_b` per player, kept between traversals (see `pairProduct`), with the
   * stamp each was computed at. Allocated on first use.
   */
  products: (Float64Array | null)[] | null;
  stamps: Float64Array | null;
}

export class PreflopSolver {
  readonly game: PreflopGame;
  readonly tree: PreflopTree;
  readonly params: DcfrParams;
  readonly players: number;
  /** Per node: start of its `actions x 169` block, or -1. */
  readonly offset: Int32Array;
  readonly regrets: Float64Array;
  readonly strategySum: Float64Array;
  /** The limp tremble `ε` (0: none). */
  readonly limpFloor: number;
  /** Per node: the child index of a trembling limp edge, or -1. */
  readonly floorEdge: Int8Array;
  /** Per action per class EV in bb, from the last `evaluate()`. */
  ev: Float64Array | null = null;
  iterations = 0;

  private readonly terminals = new Map<number, Terminal>();
  private readonly reach: Float64Array;
  private readonly saveBuf: Float64Array[] = [];
  /** Per depth: the mass of the player who folded on the edge into that depth. */
  private readonly foldBuf: Float64Array[] = [];
  /**
   * Per player: its mass `R_q` while the walk is below its fold, else null.
   * A folded player's reach never changes again on that path, so its mass is
   * computed once at the fold instead of at every terminal below it - the
   * same numbers in the same order, about twice as fast at nine seats.
   */
  private readonly foldMass: (Float64Array | null)[] = [];
  private readonly cfvBuf: Float64Array[] = [];
  private readonly stratBuf: Float64Array[] = [];
  private readonly playBuf: Float64Array[] = [];
  private readonly baseBuf = new Float64Array(H);
  private readonly shareN = new Float64Array(H);
  private readonly tmpW = new Float64Array(H);
  private readonly tmpM = new Float64Array(H);
  private readonly tmpX = new Float64Array(H);
  private readonly tmpA = new Float64Array(H);
  private readonly tmpC = new Float64Array(H);
  private readonly tmpE = new Float64Array(H);
  private readonly tmpF = new Float64Array(H);
  private readonly rankSum = new Float64Array(13);
  private readonly sumBuf = new Float64Array(H);
  private readonly rootOut = new Float64Array(H);

  private readonly cardRemoval: boolean;
  private trav = 0;
  private mode = MODE_CFR;
  private recordEv = false;
  private dPos = 0;
  private dNeg = 0;
  private wStrat = 1;
  /**
   * Cache stamps for the multiway products (`pairProduct`): a player's reach
   * at a terminal changes only when its own regrets do - in its own CFR
   * traversal - so a product `S_ab π_b` stays valid until `b`'s next one.
   * `epoch[b]` counts those traversals; `generation` changes with every
   * `iterate`, `exploitability` and `evaluate` call (a change of mode, or
   * regrets set from outside between calls).
   */
  private readonly epoch: Int32Array;
  private generation = 0;

  constructor(game: PreflopGame, params: Partial<DcfrParams> = {}) {
    this.game = game;
    this.tree = game.tree;
    this.params = { ...DEFAULT_DCFR, ...params };
    const tree = game.tree;
    const n = tree.players.length;
    this.players = n;
    this.cardRemoval = game.cardRemoval ?? true;

    const offset = new Int32Array(tree.size).fill(-1);
    let total = 0;
    for (let node = 0; node < tree.size; node += 1) {
      if (tree.type[node] === PF_ACTION) {
        offset[node] = total;
        total += tree.childCount[node] * H;
      }
    }
    this.offset = offset;
    this.regrets = new Float64Array(total);
    this.strategySum = new Float64Array(total);
    this.limpFloor = Math.max(0, game.limpFloor ?? 0);
    this.floorEdge = new Int8Array(tree.size).fill(-1);
    if (this.limpFloor > 0) {
      for (let node = 0; node < tree.size; node += 1) {
        if (tree.type[node] !== PF_ACTION || tree.level[node] !== 0) continue;
        const actor = tree.players[tree.actor[node]];
        if (actor === "SB" || actor === "BB") continue;
        for (let a = 0; a < tree.childCount[node]; a += 1) {
          if (tree.edgeCode[tree.childStart[node] + a] === "c") this.floorEdge[node] = a;
        }
      }
    }

    this.reach = new Float64Array(n * H);
    this.epoch = new Int32Array(n);
    for (let p = 0; p < n; p += 1) this.foldMass.push(null);
    for (let d = 0; d <= tree.maxDepth + 1; d += 1) {
      this.saveBuf.push(new Float64Array(H));
      this.foldBuf.push(new Float64Array(H));
      this.cfvBuf.push(new Float64Array(tree.maxChildren * H));
      this.stratBuf.push(new Float64Array(tree.maxChildren * H));
      this.playBuf.push(new Float64Array(tree.maxChildren * H));
    }

    // Terminals and their share matrices, cached by (pot type, both roles).
    const model = game.realisation ?? CHARTS1_REALISATION;
    const weights = new Map<string, Float64Array>();
    const weightsOf = (potType: PotType, role: RealisationRole): Float64Array => {
      const key = `${potType}:${role}`;
      let w = weights.get(key);
      if (!w) {
        w = roleWeights(model, potType, role);
        weights.set(key, w);
      }
      return w;
    };
    const cache = new Map<string, Float64Array>();
    const matrix = (potType: PotType, hero: RealisationRole, opp: RealisationRole): Float64Array => {
      const key = `${potType}:${hero}:${opp}`;
      let m = cache.get(key);
      if (!m) {
        const s = shareMatrix(game.equity, weightsOf(potType, hero), weightsOf(potType, opp), this.cardRemoval);
        m = new Float64Array(H * H);
        for (let i = 0; i < H; i += 1) {
          for (let j = 0; j < H; j += 1) {
            m[j * H + i] = s[i * H + j];
          }
        }
        cache.set(key, m);
      }
      return m;
    };
    for (let node = 0; node < tree.size; node += 1) {
      const kind = tree.type[node];
      if (kind === PF_ACTION) continue;
      const live: number[] = [];
      let pot = 0;
      for (let p = 0; p < n; p += 1) {
        pot += tree.contrib[node * n + p];
        if (tree.live[node] & (1 << p)) live.push(p);
      }
      const share: (Float64Array | null)[][] = [];
      let net = pot;
      if (kind !== PF_FOLD) {
        const potType = POT_TYPE_INDEX[tree.potType[node]];
        net = pot - flopRake(pot, potType, game.rake);
        const agg = tree.aggressor[node];
        for (let a = 0; a < n; a += 1) {
          share.push([]);
          for (let b = 0; b < n; b += 1) {
            if (a === b || !live.includes(a) || !live.includes(b)) {
              share[a].push(null);
              continue;
            }
            const ip = POSTFLOP_ORDER[tree.players[a]] > POSTFLOP_ORDER[tree.players[b]];
            share[a].push(matrix(potType, realisationRole(ip, agg === a), realisationRole(!ip, agg === b)));
          }
        }
      }
      this.terminals.set(node, { kind, live, pot, net, share, products: null, stamps: null });
    }
  }

  /** Runs `count` iterations, each updating every player once, in seat order. */
  iterate(count = 1, only?: readonly number[]): void {
    const { alpha, beta, gamma } = this.params;
    for (let k = 0; k < count; k += 1) {
      const t = ++this.iterations;
      const pa = Math.pow(t - 1, alpha);
      const pb = Math.pow(t - 1, beta);
      this.dPos = pa / (pa + 1);
      this.dNeg = pb / (pb + 1);
      this.wStrat = Math.pow(t, gamma);
      this.mode = MODE_CFR;
      if (k === 0) this.generation += 1;
      for (let p = 0; p < this.players; p += 1) {
        if (only && !only.includes(p)) continue;
        this.rootWalk(p);
        this.epoch[p] += 1;
      }
    }
  }

  /** Best-response gains and values of the average profile. */
  exploitability(): PreflopExploitability {
    const n = this.players;
    const bestResponse: number[] = [];
    const value: number[] = [];
    this.generation += 1;
    for (let p = 0; p < n; p += 1) {
      this.mode = MODE_BEST;
      bestResponse.push(this.rootValue(p));
      this.mode = MODE_EVAL;
      value.push(this.rootValue(p));
    }
    const gainMbb = bestResponse.map((br, p) => 1000 * (br - value[p]));
    return {
      bestResponse,
      value,
      gainMbb,
      nashConvMbb: gainMbb.reduce((a, b) => a + b, 0),
      valueSum: value.reduce((a, b) => a + b, 0),
    };
  }

  /**
   * Records, for every action node, each action's EV in bb for every class of
   * the actor: expected net chips from the start of the hand, given the class
   * is at that node and everyone plays the average strategy from there on.
   * Returns each player's value of the game.
   */
  evaluate(): number[] {
    this.ev ??= new Float64Array(this.regrets.length);
    this.recordEv = true;
    const out: number[] = [];
    this.generation += 1;
    try {
      this.mode = MODE_EVAL;
      for (let p = 0; p < this.players; p += 1) {
        out.push(this.rootValue(p));
      }
    } finally {
      this.recordEv = false;
    }
    return out;
  }

  /** Average strategy at an action node as `[action * 169 + class]`. */
  averageStrategy(node: number): Float64Array {
    const count = this.tree.childCount[node];
    const out = new Float64Array(count * H);
    this.average(this.offset[node], count, out);
    this.floor(node, count, out, out);
    return out;
  }

  /** Current (regret-matched) strategy at an action node, `[action * 169 + class]`. */
  currentStrategy(node: number): Float64Array {
    const count = this.tree.childCount[node];
    const out = new Float64Array(count * H);
    this.regretMatch(this.offset[node], count, out);
    this.floor(node, count, out, out);
    return out;
  }

  /**
   * Probability that each player's class reaches `node` under the average
   * strategy, per player `[player * 169 + class]`.
   */
  reachAt(node: number): Float64Array {
    const tree = this.tree;
    const n = this.players;
    // Path from the root: parents by search (trees are small).
    const parent = new Int32Array(tree.size).fill(-1);
    const via = new Int32Array(tree.size).fill(-1);
    for (let id = 0; id < tree.size; id += 1) {
      for (let e = tree.childStart[id]; e < tree.childStart[id] + tree.childCount[id]; e += 1) {
        parent[tree.children[e]] = id;
        via[tree.children[e]] = e - tree.childStart[id];
      }
    }
    const out = new Float64Array(n * H).fill(1);
    const path: number[] = [];
    for (let id = node; parent[id] >= 0; id = parent[id]) path.push(id);
    path.reverse();
    for (const child of path) {
      const at = parent[child];
      const a = via[child];
      const p = tree.actor[at];
      const strat = this.averageStrategy(at);
      for (let i = 0; i < H; i += 1) out[p * H + i] *= strat[a * H + i];
    }
    return out;
  }

  /* --------------------------------------------------------------- walk - */

  private rootValue(p: number): number {
    this.rootWalk(p);
    let sum = 0;
    for (let i = 0; i < H; i += 1) {
      sum += (CLASS_COMBOS[i] / NUM_COMBOS) * this.rootOut[i];
    }
    return sum;
  }

  private rootWalk(p: number): void {
    this.trav = p;
    this.reach.fill(1);
    this.walk(0, 0, this.rootOut, 0);
  }

  private walk(node: number, depth: number, out: Float64Array, oOff: number): void {
    const tree = this.tree;
    const type = tree.type[node];
    if (type !== PF_ACTION) {
      this.terminal(node, out, oOff);
      return;
    }
    const p = this.trav;
    const q = tree.actor[node];
    const start = tree.childStart[node];
    const count = tree.childCount[node];
    const off = this.offset[node];
    const strat = this.stratBuf[depth];
    const mode = this.mode;
    const reach = this.reach;
    const save = this.saveBuf[depth];
    const base = q * H;

    if (q === p ? mode !== MODE_EVAL : mode === MODE_CFR) {
      this.regretMatch(off, count, strat);
    } else {
      this.average(off, count, strat);
    }
    for (let i = 0; i < H; i += 1) save[i] = reach[base + i];
    // The strategy played: `strat` itself, or its trembling version. The
    // traverser's regrets and strategy sum keep the free part `strat`.
    const fe = this.floorEdge[node];
    let play = strat;
    if (fe >= 0) {
      if (q === p && mode === MODE_CFR) play = this.playBuf[depth];
      this.floor(node, count, strat, play);
    }

    if (q === p) {
      const cfv = this.cfvBuf[depth];
      for (let a = 0; a < count; a += 1) {
        const child = tree.children[start + a];
        if (tree.edgeCode[start + a] === "f") {
          this.foldValue(node, cfv, a * H);
          continue;
        }
        const s0 = a * H;
        for (let i = 0; i < H; i += 1) reach[base + i] = save[i] * play[s0 + i];
        this.walk(child, depth + 1, cfv, a * H);
      }
      for (let i = 0; i < H; i += 1) reach[base + i] = save[i];

      if (mode === MODE_BEST) {
        const eps = fe >= 0 ? this.limpFloor : 0;
        for (let i = 0; i < H; i += 1) {
          let best = cfv[i];
          for (let a = 1; a < count; a += 1) {
            const v = cfv[a * H + i];
            if (v > best) best = v;
          }
          // In the perturbed game a best response still limps `ε`.
          out[oOff + i] = fe >= 0 ? (1 - eps) * best + eps * cfv[fe * H + i] : best;
        }
        return;
      }
      for (let i = 0; i < H; i += 1) out[oOff + i] = play[i] * cfv[i];
      for (let a = 1; a < count; a += 1) {
        const s0 = a * H;
        for (let i = 0; i < H; i += 1) out[oOff + i] += play[s0 + i] * cfv[s0 + i];
      }
      if (mode === MODE_CFR) {
        const regrets = this.regrets;
        const sums = this.strategySum;
        const dPos = this.dPos;
        const dNeg = this.dNeg;
        const w = this.wStrat;
        // The regret baseline is the free part's value: `out` itself without a tremble.
        let baseline: Float64Array = out;
        let bOff = oOff;
        if (fe >= 0) {
          baseline = this.baseBuf;
          bOff = 0;
          for (let i = 0; i < H; i += 1) baseline[i] = strat[i] * cfv[i];
          for (let a = 1; a < count; a += 1) {
            const s0 = a * H;
            for (let i = 0; i < H; i += 1) baseline[i] += strat[s0 + i] * cfv[s0 + i];
          }
        }
        for (let a = 0; a < count; a += 1) {
          const s0 = a * H;
          const r0 = off + s0;
          for (let i = 0; i < H; i += 1) {
            const r = regrets[r0 + i];
            regrets[r0 + i] = (r > 0 ? r * dPos : r * dNeg) + cfv[s0 + i] - baseline[bOff + i];
            sums[r0 + i] += w * save[i] * strat[s0 + i];
          }
        }
      } else if (this.recordEv) {
        const ev = this.ev as Float64Array;
        const norm = this.tmpF;
        this.opponentMass(norm);
        for (let a = 0; a < count; a += 1) {
          const s0 = a * H;
          for (let i = 0; i < H; i += 1) {
            ev[off + s0 + i] = norm[i] > 0 ? cfv[s0 + i] / norm[i] : 0;
          }
        }
      }
      return;
    }

    // Another player's node: split its reach by its strategy.
    const cfv = this.cfvBuf[depth];
    out.fill(0, oOff, oOff + H);
    for (let a = 0; a < count; a += 1) {
      const s0 = a * H;
      let any = 0;
      for (let i = 0; i < H; i += 1) {
        const v = save[i] * play[s0 + i];
        reach[base + i] = v;
        any += v;
      }
      if (any === 0) continue;
      const folds = tree.edgeCode[start + a] === "f";
      if (folds) {
        const mass = this.foldBuf[depth + 1];
        this.massOf(reach.subarray(base, base + H), mass);
        this.foldMass[q] = mass;
      }
      this.walk(tree.children[start + a], depth + 1, cfv, 0);
      if (folds) this.foldMass[q] = null;
      for (let i = 0; i < H; i += 1) out[oOff + i] += cfv[i];
    }
    for (let i = 0; i < H; i += 1) reach[base + i] = save[i];
  }

  /** `R_q`: the cached mass of a folded player, or computed into `scratch`. */
  private massOfPlayer(q: number, scratch: Float64Array): Float64Array {
    const cached = this.foldMass[q];
    if (cached) return cached;
    this.massOf(this.reach.subarray(q * H, q * H + H), scratch);
    return scratch;
  }

  /** `R(i)` of an opponent's reach vector, with or without card removal. */
  private massOf(x: ArrayLike<number>, out: Float64Array): void {
    if (this.cardRemoval) {
      massVector(x, out, this.rankSum);
    } else {
      independentMass(x, out);
    }
  }

  /** `Π_{q ≠ trav} R_q(i)` into `out`. */
  private opponentMass(out: Float64Array): void {
    out.fill(1);
    for (let q = 0; q < this.players; q += 1) {
      if (q === this.trav) continue;
      const m = this.massOfPlayer(q, this.tmpE);
      for (let i = 0; i < H; i += 1) out[i] *= m[i];
    }
  }

  /** The traverser folds at `node`: `-contribution x opponents' mass`. */
  private foldValue(node: number, out: Float64Array, oOff: number): void {
    const lost = this.tree.contrib[node * this.players + this.trav];
    const norm = this.tmpF;
    this.opponentMass(norm);
    for (let i = 0; i < H; i += 1) out[oOff + i] = -lost * norm[i];
  }

  private terminal(node: number, out: Float64Array, oOff: number): void {
    const t = this.terminals.get(node) as Terminal;
    const p = this.trav;
    const n = this.players;
    const tree = this.tree;
    const cp = tree.contrib[node * n + p];
    const reach = this.reach;

    // A player whose only option was to fold has no node of its own, so the
    // walk can reach a terminal past the traverser's (silent) fold.
    if (!t.live.includes(p)) {
      this.foldValue(node, out, oOff);
      return;
    }

    // Mass of every opponent; the folded ones multiply into `fold`.
    const fold = this.tmpF;
    fold.fill(1);
    const m = this.tmpE;
    const active: number[] = [];
    for (let q = 0; q < n; q += 1) {
      if (q === p) continue;
      if (t.live.includes(q)) {
        active.push(q);
        continue;
      }
      const mq = this.massOfPlayer(q, m);
      for (let i = 0; i < H; i += 1) fold[i] *= mq[i];
    }

    if (t.kind === PF_FOLD) {
      // The traverser is live, so it is the winner.
      const won = t.pot - cp;
      for (let i = 0; i < H; i += 1) out[oOff + i] = won * fold[i];
      return;
    }

    if (active.length === 1) {
      const q = active[0];
      const rq = reach.subarray(q * H, q * H + H);
      const share = this.tmpA;
      matVecT(t.share[p][q] as Float64Array, rq, share);
      this.massOf(rq, m);
      for (let i = 0; i < H; i += 1) {
        out[oOff + i] = fold[i] * (t.net * share[i] - cp * m[i]);
      }
      return;
    }

    // Multiway (see preflopModel.ts), n = live players:
    //   share = (1 - 1/n) Π_q A_q + (1/n) Π_q R_q - (1/n) Σ_q term_q
    // with A_q = S_pq π_q (p's expected pairwise share against q), R_q the
    // mass of q, and term_q the expected "q beats everyone":
    //   term_q = M w_q - S_pq w_q,   w_q(j) = π_q(j) Π_{r ≠ p,q} (S_qr π_r)(j).
    const nLive = active.length + 1;
    const share = this.shareN;
    const prodR = this.tmpC;
    share.fill(1);
    prodR.fill(1);
    for (const q of active) {
      const A = this.pairProduct(t, p, q);
      const mq = this.pairProduct(t, q, q);
      for (let i = 0; i < H; i += 1) {
        share[i] *= A[i];
        prodR[i] *= mq[i];
      }
    }
    for (let i = 0; i < H; i += 1) {
      share[i] = (1 - 1 / nLive) * share[i] + prodR[i] / nLive;
    }
    for (const q of active) {
      const weighted = this.tmpW;
      weighted.set(reach.subarray(q * H, q * H + H));
      for (const r of active) {
        if (r === q) continue;
        const T = this.pairProduct(t, q, r);
        for (let j = 0; j < H; j += 1) weighted[j] *= T[j];
      }
      const mass = this.tmpM;
      this.massOf(weighted, mass);
      const beaten = this.tmpX;
      matVecT(t.share[p][q] as Float64Array, weighted, beaten);
      for (let i = 0; i < H; i += 1) share[i] -= (mass[i] - beaten[i]) / nLive;
    }
    for (let i = 0; i < H; i += 1) {
      out[oOff + i] = fold[i] * (t.net * share[i] - cp * prodR[i]);
    }
  }

  /**
   * At a multiway terminal: `S_ab π_b` for `a ≠ b` (a's expected pairwise
   * share against b's reach), or `R_b` for `a = b`, computed once and kept
   * until `b`'s strategy changes (`epoch`) or the solver changes mode
   * (`generation`). The same numbers as computing them afresh - each depends
   * on `b`'s reach alone, which only `b`'s own traversal changes - at a third
   * to a half of the multiway cost (a pair is otherwise recomputed by every
   * other live player's traversal).
   */
  private pairProduct(t: Terminal, a: number, b: number): Float64Array {
    const n = this.players;
    if (!t.products || !t.stamps) {
      t.products = new Array(n * n).fill(null);
      t.stamps = new Float64Array(n * n).fill(-1);
    }
    const k = a * n + b;
    const stamp = this.generation * 1e7 + this.epoch[b];
    let out = t.products[k];
    if (out && t.stamps[k] === stamp) return out;
    if (!out) {
      out = new Float64Array(H);
      t.products[k] = out;
    }
    const rb = this.reach.subarray(b * H, b * H + H);
    if (a === b) this.massOf(rb, out);
    else matVecT(t.share[a][b] as Float64Array, rb, out);
    t.stamps[k] = stamp;
    return out;
  }

  /* --------------------------------------------------------- strategies - */

  /** `out = (1 - ε)·x + ε·e_limp` at a trembling node; a copy of `x` elsewhere (nothing when in place). */
  private floor(node: number, count: number, x: Float64Array, out: Float64Array): void {
    const fe = this.floorEdge[node];
    if (fe < 0) {
      if (out !== x) out.set(x.subarray(0, count * H));
      return;
    }
    const keep = 1 - this.limpFloor;
    for (let k = 0; k < count * H; k += 1) out[k] = keep * x[k];
    const s0 = fe * H;
    for (let i = 0; i < H; i += 1) out[s0 + i] += this.limpFloor;
  }

  private regretMatch(off: number, count: number, strat: Float64Array): void {
    const regrets = this.regrets;
    const sum = this.sumBuf;
    sum.fill(0);
    for (let a = 0; a < count; a += 1) {
      const r0 = off + a * H;
      for (let i = 0; i < H; i += 1) {
        const r = regrets[r0 + i];
        if (r > 0) sum[i] += r;
      }
    }
    const uniform = 1 / count;
    for (let a = 0; a < count; a += 1) {
      const s0 = a * H;
      const r0 = off + s0;
      for (let i = 0; i < H; i += 1) {
        const r = regrets[r0 + i];
        const s = sum[i];
        strat[s0 + i] = s > 0 ? (r > 0 ? r / s : 0) : uniform;
      }
    }
  }

  private average(off: number, count: number, strat: Float64Array): void {
    const sums = this.strategySum;
    const sum = this.sumBuf;
    sum.fill(0);
    for (let a = 0; a < count; a += 1) {
      const r0 = off + a * H;
      for (let i = 0; i < H; i += 1) sum[i] += sums[r0 + i];
    }
    const uniform = 1 / count;
    for (let a = 0; a < count; a += 1) {
      const s0 = a * H;
      const r0 = off + s0;
      for (let i = 0; i < H; i += 1) {
        const s = sum[i];
        strat[s0 + i] = s > 0 ? sums[r0 + i] / s : uniform;
      }
    }
  }
}

/** `out[i] = Σ_j S[i][j] x[j]`, with `t` holding S transposed (`t[j * 169 + i]`). */
function matVecT(t: Float64Array, x: ArrayLike<number>, out: Float64Array): void {
  out.fill(0);
  for (let j = 0; j < H; j += 1) {
    const v = x[j];
    if (v === 0) continue;
    const row = j * H;
    for (let i = 0; i < H; i += 1) out[i] += t[row + i] * v;
  }
}
