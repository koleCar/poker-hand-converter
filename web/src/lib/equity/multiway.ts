/**
 * One exact hand against two or more weighted ranges at once: the multiway
 * version of `equityVsRange` (phase A9, `docs/ANALYSIS-PLAN.md` §10).
 *
 * "The field" is every opponent still in. The hero's share of the pot is what
 * a showdown against all of them pays: the whole pot when the hero's hand is
 * strictly the best, `1 / (1 + k)` of it when it ties with `k` of them for the
 * best, nothing when anyone beats it.
 *
 * **Card removal across every range.** A deal is one combo from each range
 * plus the rest of the board, and no card may appear twice in it: the hero's
 * cards, the board, the dead cards and the other opponents' combos all block.
 * A tuple of combos is weighted by the product of their weights, so the
 * joint distribution is `∏ wᵢ` over the compatible tuples — exactly what the
 * exhaustive walk sums and what the sampler draws (it rejects a whole tuple
 * that collides, never one combo of it, which would bias the draw towards
 * combos that block less).
 *
 * **Exhaustive or sampled, deterministically**, like `equityVsRange`:
 * `"auto"` enumerates when the tuples times the runouts fit `exhaustiveLimit`
 * (two river ranges of a few hundred combos each do), and otherwise draws
 * `trials` seeded deals.
 *
 * Hold'em only, like `range.ts`.
 */

import { DEFAULT_SEED, EquityInputError, mulberry32 } from "./enumerate";
import { cardIndex, evaluateMasks, STANDARD } from "./evaluator";
import { rangeCombos, type ClassWeights, type WeightedCombo } from "./range";

export interface MultiwayEquityRequest {
  /** The hero's two hole cards, as codes like `"Ah"`. */
  hero: readonly string[];
  /** One range per opponent: classes with weights, or combos already expanded. At least one. */
  ranges: ReadonlyArray<ClassWeights | readonly WeightedCombo[]>;
  /** 0, 3, 4 or 5 board cards. */
  board?: readonly string[];
  /** Cards known to be out of play that no hand holds. */
  dead?: readonly string[];
  method?: "auto" | "exhaustive" | "monte-carlo";
  /** Tuples × runouts `"auto"` still enumerates. */
  exhaustiveLimit?: number;
  trials?: number;
  seed?: number;
}

export interface MultiwayEquityResult {
  /** The hero's share of the pot: wins, plus each tie split by the players in it. In [0, 1]. */
  equity: number;
  /** Weighted share of deals the hero wins outright. */
  win: number;
  /** Weighted share of deals the hero ties for the best hand (with one opponent or more). */
  tie: number;
  /** Combos left in each range after the hero's cards, the board and the dead cards are removed. */
  combos: number[];
  method: "exhaustive" | "monte-carlo";
  /** Deals enumerated or sampled. */
  samples: number;
}

/** Two river ranges of ~700 combos each still enumerate; anything with a runout to deal mostly samples. */
export const DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT = 500_000;
export const DEFAULT_MULTIWAY_TRIALS = 8_000;
/** A sampler gives up on a deal after this many collisions in a row (ranges that can barely coexist). */
const MAX_REJECTIONS = 2_000;

function choose(n: number, k: number): number {
  let out = 1;
  for (let i = 0; i < k; i += 1) out = (out * (n - i)) / (i + 1);
  return Math.round(out);
}

function card(code: string, seen: Set<number>): number {
  const index = cardIndex(code);
  if (index < 0) throw new EquityInputError(`not a card: ${code}`);
  if (seen.has(index)) throw new EquityInputError(`${code} appears twice`);
  seen.add(index);
  return index;
}

const isComboList = (range: ClassWeights | readonly WeightedCombo[]): range is readonly WeightedCombo[] => Array.isArray(range);

/**
 * The hero's equity against every range at once, over every runout.
 *
 * Throws `EquityInputError` for an impossible request (no range, a duplicated
 * card, a board of two). A range card removal empties is not an error: that
 * opponent cannot be holding anything, so it is left out of the showdown (an
 * empty field returns an equity of 1), and its `combos` entry is 0.
 */
export function equityVsRanges(request: MultiwayEquityRequest): MultiwayEquityResult {
  if (request.hero.length !== 2) throw new EquityInputError(`the hero needs two hole cards, got ${request.hero.length}`);
  if (request.ranges.length === 0) throw new EquityInputError("a multiway equity needs at least one range");
  const seen = new Set<number>();
  const hero = request.hero.map((code) => card(code, seen));
  const board = (request.board ?? []).map((code) => card(code, seen));
  if (board.length > 5 || board.length === 1 || board.length === 2) {
    throw new EquityInputError(`a board of ${board.length} cards is not a street`);
  }
  for (const code of request.dead ?? []) card(code, seen);

  const all = request.ranges.map((range) =>
    isComboList(range)
      ? range.filter(({ cards: [a, b], weight }) => weight > 0 && !seen.has(a) && !seen.has(b))
      : rangeCombos(range, seen),
  );
  const counts = all.map((combos) => combos.length);
  const ranges = all.filter((combos) => combos.length > 0);
  if (ranges.length === 0) {
    return { equity: 1, win: 1, tie: 0, combos: counts, method: "exhaustive", samples: 0 };
  }

  const missing = 5 - board.length;
  const deckLeft = 52 - seen.size - 2 * ranges.length;
  const runouts = choose(Math.max(0, deckLeft), missing);
  let tuples = 1;
  for (const combos of ranges) tuples *= combos.length;
  const method = request.method ?? "auto";
  const exhaustive =
    method === "exhaustive" ||
    (method === "auto" && tuples * runouts <= (request.exhaustiveLimit ?? DEFAULT_MULTIWAY_EXHAUSTIVE_LIMIT));

  const heroMasks = [0, 0, 0, 0];
  for (const index of hero) heroMasks[index & 3] |= 1 << (index >> 2);
  const boardMasks = [0, 0, 0, 0];
  for (const index of board) boardMasks[index & 3] |= 1 << (index >> 2);
  const k = ranges.length;
  const picked: WeightedCombo[] = new Array(k);
  const scratch = new Int32Array(4);

  let win = 0;
  let tie = 0;
  let share = 0;
  let total = 0;
  let samples = 0;

  /** Scores one complete deal: the board masks with the runout, the combos in `picked`. */
  const score = (s: number, h: number, d: number, c: number, w: number) => {
    const ours = evaluateMasks(STANDARD, s | heroMasks[0], h | heroMasks[1], d | heroMasks[2], c | heroMasks[3]);
    let tied = 0;
    let beaten = false;
    for (let i = 0; i < k; i += 1) {
      const [a, b] = picked[i].cards;
      scratch[0] = s;
      scratch[1] = h;
      scratch[2] = d;
      scratch[3] = c;
      scratch[a & 3] |= 1 << (a >> 2);
      scratch[b & 3] |= 1 << (b >> 2);
      const theirs = evaluateMasks(STANDARD, scratch[0], scratch[1], scratch[2], scratch[3]);
      if (theirs > ours) {
        beaten = true;
        break;
      }
      if (theirs === ours) tied += 1;
    }
    if (!beaten) {
      if (tied === 0) win += w;
      else tie += w;
      share += w / (1 + tied);
    }
    total += w;
    samples += 1;
  };

  const used = new Uint8Array(52);
  for (const index of seen) used[index] = 1;

  if (exhaustive) {
    const recurse = (depth: number, weight: number) => {
      if (depth === k) {
        const stub: number[] = [];
        for (let index = 0; index < 52; index += 1) if (!used[index]) stub.push(index);
        const per = weight / Math.max(1, choose(stub.length, missing));
        walkRunouts(stub, missing, boardMasks, (s, h, d, c) => score(s, h, d, c, per));
        return;
      }
      for (const combo of ranges[depth]) {
        const [a, b] = combo.cards;
        if (used[a] || used[b]) continue;
        used[a] = 1;
        used[b] = 1;
        picked[depth] = combo;
        recurse(depth + 1, weight * combo.weight);
        used[a] = 0;
        used[b] = 0;
      }
    };
    recurse(0, 1);
  } else {
    const random = mulberry32(request.seed ?? DEFAULT_SEED);
    const cumulative = ranges.map((combos) => {
      const out = new Float64Array(combos.length);
      let sum = 0;
      combos.forEach((combo, index) => {
        sum += combo.weight;
        out[index] = sum;
      });
      return out;
    });
    const trials = Math.max(1, Math.floor(request.trials ?? DEFAULT_MULTIWAY_TRIALS));
    const drawn: number[] = [];
    for (let trial = 0; trial < trials; trial += 1) {
      // Draw a whole compatible tuple, rejecting it whole on a collision.
      let ok = false;
      for (let attempt = 0; attempt < MAX_REJECTIONS && !ok; attempt += 1) {
        ok = true;
        let i = 0;
        for (; i < k; i += 1) {
          const sums = cumulative[i];
          const combo = ranges[i][pickWeighted(sums, random() * sums[sums.length - 1])];
          const [a, b] = combo.cards;
          if (used[a] || used[b]) {
            ok = false;
            break;
          }
          used[a] = 1;
          used[b] = 1;
          picked[i] = combo;
        }
        if (!ok) {
          for (let j = 0; j < i; j += 1) {
            used[picked[j].cards[0]] = 0;
            used[picked[j].cards[1]] = 0;
          }
        }
      }
      if (!ok) continue;
      const masks = [...boardMasks];
      drawn.length = 0;
      while (drawn.length < missing) {
        const index = Math.floor(random() * 52);
        if (used[index]) continue;
        used[index] = 1;
        drawn.push(index);
        masks[index & 3] |= 1 << (index >> 2);
      }
      score(masks[0], masks[1], masks[2], masks[3], 1);
      for (const index of drawn) used[index] = 0;
      for (let j = 0; j < k; j += 1) {
        used[picked[j].cards[0]] = 0;
        used[picked[j].cards[1]] = 0;
      }
    }
  }

  if (!(total > 0)) {
    // No compatible deal at all: the ranges cannot coexist with these cards.
    return { equity: 1, win: 1, tie: 0, combos: counts, method: exhaustive ? "exhaustive" : "monte-carlo", samples };
  }
  return {
    equity: share / total,
    win: win / total,
    tie: tie / total,
    combos: counts,
    method: exhaustive ? "exhaustive" : "monte-carlo",
    samples,
  };
}

/** First index whose cumulative weight exceeds `target`. */
function pickWeighted(cumulative: Float64Array, target: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Every way to deal `missing` cards from `stub` onto the board's masks. */
function walkRunouts(
  stub: number[],
  missing: number,
  boardMasks: number[],
  visit: (s: number, h: number, d: number, c: number) => void,
): void {
  const masks = [...boardMasks];
  const recurse = (from: number, left: number) => {
    if (left === 0) {
      visit(masks[0], masks[1], masks[2], masks[3]);
      return;
    }
    for (let i = from; i <= stub.length - left; i += 1) {
      const index = stub[i];
      const bit = 1 << (index >> 2);
      const suit = index & 3;
      const before = masks[suit];
      masks[suit] |= bit;
      recurse(i + 1, left - 1);
      masks[suit] = before;
    }
  };
  recurse(0, missing);
}
