/**
 * The public game tree, flattened into typed arrays.
 *
 * **Public tree, private vectors.** A node here is a *public* state: the
 * betting so far and the board. Private cards are not in the tree at all; each
 * player's possible hands are a vector (`game.ts`), and every node carries a
 * whole vector of values at once. That is the shape modern postflop solvers
 * use, and it is what makes range-vs-range solving affordable: a river tree
 * has tens of nodes, not tens of thousands, and each one is a tight loop over
 * a few hundred floats.
 *
 * **Flat, not objects.** Node fields live in parallel typed arrays indexed by
 * node id, and a node's children are a contiguous slice of `children`. The CFR
 * walk touches every node every iteration; an array of objects would cost a
 * pointer chase and a hidden-class check per field per visit, and would not
 * survive `postMessage` to a worker without being rebuilt.
 *
 * **Payoffs are stored, not computed.** A terminal records what each player
 * nets there - win, lose and tie amounts for a showdown, one amount per player
 * for a fold - already net of rake. The solver multiplies them by reach sums
 * and never needs to know about pots, stacks or rake. That also makes the toy
 * games (Kuhn, Leduc, the clairvoyance game) ordinary trees for the same
 * engine instead of special cases.
 */

/** A decision by `player`. */
export const ACTION = 0;
/** `player` folded; the other player takes the pot. */
export const FOLD = 1;
/** Hands are compared on board `board`. */
export const SHOWDOWN = 2;
/** A public card is dealt; each child is one card. */
export const CHANCE = 3;

/** Rake as a fraction of the final pot, capped. `{ percent: 0.05, cap: 3 }`. */
export interface Rake {
  /** Fraction of the pot, e.g. `0.05` for 5%. */
  percent: number;
  /** The most taken from one pot, in the same units as the pot. */
  cap: number;
}

export interface FlatTree {
  readonly size: number;
  readonly root: number;
  readonly type: Uint8Array;
  /** Actor for `ACTION`, folder for `FOLD`, 0 otherwise. */
  readonly player: Uint8Array;
  readonly childStart: Int32Array;
  readonly childCount: Int32Array;
  /** Child node ids; a node's children are `children[childStart .. +childCount]`. */
  readonly children: Int32Array;
  /** Label of each edge, parallel to `children`: an action label or a card code. */
  readonly edgeLabel: readonly string[];
  /** Card dealt on each edge of a chance node, parallel to `children`; -1 elsewhere. */
  readonly edgeCard: Int32Array;
  /**
   * Six numbers per node. Showdown: `[win0, lose0, tie0, win1, lose1, tie1]`,
   * each player's net chips for that outcome. Fold: `amount0` at slot 0 and
   * `amount1` at slot 3.
   */
  readonly payoff: Float64Array;
  /** Showdown board id (index into `game.boards`); -1 elsewhere. */
  readonly board: Int32Array;
  /** Probability of each chance outcome given both players' hands. */
  readonly chanceWeight: Float64Array;
  /** Longest root-to-leaf path in edges, for sizing per-depth scratch. */
  readonly maxDepth: number;
  /** Most children of any node. */
  readonly maxChildren: number;
}

/** One edge handed to `TreeBuilder.action` / `chance`. */
export interface Edge {
  label: string;
  child: number;
  /** Chance edges only: the card dealt. */
  card?: number;
}

/** Rake taken from a final pot. */
export function rakeOf(pot: number, rake: Rake | undefined): number {
  if (!rake || rake.percent <= 0) {
    return 0;
  }
  return Math.min(pot * rake.percent, rake.cap);
}

/**
 * Builds a `FlatTree` bottom-up: create the children, then the node that
 * points at them. Node ids are assigned in creation order; the root is
 * whichever id is passed to `finish`.
 */
export class TreeBuilder {
  private readonly types: number[] = [];
  private readonly players: number[] = [];
  private readonly starts: number[] = [];
  private readonly counts: number[] = [];
  private readonly kids: number[] = [];
  private readonly labels: string[] = [];
  private readonly cards: number[] = [];
  private readonly payoffs: number[] = [];
  private readonly boards: number[] = [];
  private readonly weights: number[] = [];

  get size(): number {
    return this.types.length;
  }

  private add(type: number, player: number, edges: readonly Edge[], board: number, weight: number): number {
    const id = this.types.length;
    this.types.push(type);
    this.players.push(player);
    this.starts.push(this.kids.length);
    this.counts.push(edges.length);
    for (const edge of edges) {
      this.kids.push(edge.child);
      this.labels.push(edge.label);
      this.cards.push(edge.card ?? -1);
    }
    this.boards.push(board);
    this.weights.push(weight);
    this.payoffs.push(0, 0, 0, 0, 0, 0);
    return id;
  }

  /** A decision node for `player` (0 or 1). */
  action(player: number, edges: readonly Edge[]): number {
    if (edges.length < 1) {
      throw new Error("an action node needs at least one action");
    }
    return this.add(ACTION, player, edges, -1, 0);
  }

  /** A chance node; `weight` is each outcome's probability given both hands. */
  chance(weight: number, edges: readonly Edge[]): number {
    return this.add(CHANCE, 0, edges, -1, weight);
  }

  /**
   * `folder` gives up. `pot` is dead money at the start of the game, `c0`/`c1`
   * what each player has put in since; the other player takes it all, less rake.
   */
  fold(folder: number, pot: number, c0: number, c1: number, rake?: Rake): number {
    const id = this.add(FOLD, folder, [], -1, 0);
    const total = pot + c0 + c1;
    const net = total - rakeOf(total, rake);
    const base = id * 6;
    // `0 - c`, not `-c`: a folder who put nothing in loses 0, not -0.
    this.payoffs[base] = folder === 0 ? 0 - c0 : net - c0;
    this.payoffs[base + 3] = folder === 1 ? 0 - c1 : net - c1;
    return id;
  }

  /** Hands are compared on `board`; ties split the pot. */
  showdown(board: number, pot: number, c0: number, c1: number, rake?: Rake): number {
    const id = this.add(SHOWDOWN, 0, [], board, 0);
    const total = pot + c0 + c1;
    const net = total - rakeOf(total, rake);
    const base = id * 6;
    this.payoffs[base] = net - c0;
    this.payoffs[base + 1] = 0 - c0;
    this.payoffs[base + 2] = net / 2 - c0;
    this.payoffs[base + 3] = net - c1;
    this.payoffs[base + 4] = 0 - c1;
    this.payoffs[base + 5] = net / 2 - c1;
    return id;
  }

  finish(root: number): FlatTree {
    const size = this.types.length;
    const childStart = Int32Array.from(this.starts);
    const childCount = Int32Array.from(this.counts);
    const children = Int32Array.from(this.kids);
    let maxChildren = 1;
    for (const count of this.counts) {
      maxChildren = Math.max(maxChildren, count);
    }
    // Depth by explicit stack: trees for turn+river run deep enough that a
    // recursive helper here would be the first thing to hit the stack limit.
    let maxDepth = 0;
    const stack: number[] = [root, 0];
    while (stack.length) {
      const depth = stack.pop() as number;
      const node = stack.pop() as number;
      maxDepth = Math.max(maxDepth, depth);
      for (let e = childStart[node]; e < childStart[node] + childCount[node]; e += 1) {
        stack.push(children[e], depth + 1);
      }
    }
    return {
      size,
      root,
      type: Uint8Array.from(this.types),
      player: Uint8Array.from(this.players),
      childStart,
      childCount,
      children,
      edgeLabel: this.labels.slice(),
      edgeCard: Int32Array.from(this.cards),
      payoff: Float64Array.from(this.payoffs),
      board: Int32Array.from(this.boards),
      chanceWeight: Float64Array.from(this.weights),
      maxDepth,
      maxChildren,
    };
  }
}
