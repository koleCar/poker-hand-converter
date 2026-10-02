/**
 * One exact hand against a weighted range of hands: the question every
 * heuristic in `lib/analysis` asks ("41% against a button cbet range").
 *
 * `equity()` in `enumerate.ts` answers "these known hands, every runout". This
 * answers "this known hand, against every holding the opponent could have,
 * weighted by how likely each one is, over every runout". Same evaluator, same
 * exact-or-seeded contract:
 *
 * **Card removal is the whole point.** A range is written in hand classes
 * (`AKs`, `QQ`), but what the opponent can hold is combos, and the hero's own
 * cards and the board remove some of them: with `As` on the flop there are
 * three combos of `AKs` left, not four. Every class is expanded to its combos
 * and any combo touching a dead card is dropped before anything is weighed, so
 * a blocker is worth exactly what it removes.
 *
 * **Exhaustive or sampled, deterministically.** `method: "auto"` enumerates
 * every (combo, runout) pair when that fits `exhaustiveLimit` - every river
 * and turn spot does: ~1,000 combos x 44 river cards - and otherwise draws
 * `trials` seeded samples, a combo by weight and then a runout. The seed is
 * part of the request, so a stored analysis can be reproduced bit for bit, the
 * same contract `equity()` gives an all-in.
 *
 * Hold'em only. A range of short-deck or Omaha holdings is a different object
 * (no 169-class notation, a different deck), and nothing asks for one yet.
 */

import { RANKS } from "../cards";
import { DEFAULT_SEED, EquityInputError, mulberry32 } from "./enumerate";
import { cardIndex, evaluateMasks, STANDARD } from "./evaluator";

/** Two card indices (`rank * 4 + suit`) and a relative weight in (0, 1]. */
export interface WeightedCombo {
  cards: [number, number];
  weight: number;
}

/**
 * A range as classes with weights: `{ AA: 1, AKs: 1, KQo: 0.5 }`. Classes are
 * the canonical `handClass` notation from `lib/cards`; a pair has no suffix.
 */
export type ClassWeights = ReadonlyMap<string, number>;

export interface RangeEquityRequest {
  /** The hero's two hole cards, as codes like `"Ah"`. */
  hero: readonly string[];
  /** The opponent's holdings: classes with weights, or combos already expanded. */
  range: ClassWeights | readonly WeightedCombo[];
  /** 0, 3, 4 or 5 board cards. */
  board?: readonly string[];
  /** Cards known to be out of play that neither hand holds (a folded card shown). */
  dead?: readonly string[];
  method?: "auto" | "exhaustive" | "monte-carlo";
  /** (combo, runout) pairs `"auto"` will still enumerate. */
  exhaustiveLimit?: number;
  trials?: number;
  seed?: number;
}

export interface RangeEquityResult {
  /** Hero's share of the pot: wins plus half of ties, weighted. In [0, 1]. */
  equity: number;
  /** Weighted share of outcomes the hero wins outright. */
  win: number;
  /** ...ties. `1 - win - tie` is what the hero loses. */
  tie: number;
  /** Combos left in the range after card removal. 0 means the range is empty here. */
  combos: number;
  method: "exhaustive" | "monte-carlo";
  /** (combo, runout) pairs enumerated or sampled. */
  samples: number;
}

/** Enumerates every river and turn spot; a flop or preflop spot is sampled. */
export const DEFAULT_RANGE_EXHAUSTIVE_LIMIT = 120_000;
export const DEFAULT_RANGE_TRIALS = 6_000;

/* --------------------------------------------------------------- classes - */

const RANK_INDEX = new Map<string, number>(RANKS.map((rank, index) => [rank, index]));

/** Every one of the 169 classes, pairs first, then by high card and kicker. */
export function allClasses(): string[] {
  const out: string[] = [];
  for (let high = 12; high >= 0; high -= 1) {
    out.push(`${RANKS[high]}${RANKS[high]}`);
  }
  for (let high = 12; high >= 0; high -= 1) {
    for (let low = high - 1; low >= 0; low -= 1) {
      out.push(`${RANKS[high]}${RANKS[low]}s`, `${RANKS[high]}${RANKS[low]}o`);
    }
  }
  return out;
}

/** The combos of one class, before card removal: 6 for a pair, 4 suited, 12 offsuit. */
export function classCombos(name: string): Array<[number, number]> {
  const high = RANK_INDEX.get(name[0]);
  const low = RANK_INDEX.get(name[1]);
  if (high === undefined || low === undefined) {
    throw new EquityInputError(`not a hand class: ${name}`);
  }
  const out: Array<[number, number]> = [];
  if (high === low) {
    if (name.length !== 2) {
      throw new EquityInputError(`not a hand class: ${name}`);
    }
    for (let a = 0; a < 4; a += 1) {
      for (let b = a + 1; b < 4; b += 1) {
        out.push([high * 4 + a, high * 4 + b]);
      }
    }
    return out;
  }
  const suited = name[2] === "s";
  if (name.length !== 3 || (name[2] !== "s" && name[2] !== "o") || high < low) {
    throw new EquityInputError(`not a hand class: ${name}`);
  }
  for (let a = 0; a < 4; a += 1) {
    for (let b = 0; b < 4; b += 1) {
      if ((a === b) === suited) {
        out.push([high * 4 + a, low * 4 + b]);
      }
    }
  }
  return out;
}

/**
 * Reads the usual shorthand into class weights.
 *
 * Comma-separated tokens, each optionally `:weight`:
 *
 *     QQ+        QQ, KK, AA              77-55   77, 66, 55 (22-JJ: either order)
 *     ATs+       ATs, AJs, AQs, AKs      KQ      KQs and KQo
 *     T9s-65s    T9s, 98s, 87s, 76s, 65s *       every class
 *     A5s-A2s    A5s, A4s, A3s, A2s      KTo-K8o KTo, K9o, K8o
 *     A5s:0.5    half of A5s             99-QQ:0.5  half of each pair in the span
 *
 * A class named twice keeps its larger weight, so `"AKs, AK:0.5"` is all of the
 * suited combos and half of the offsuit ones. Anything unreadable throws
 * rather than being skipped: a range with a typo in it is a different range,
 * and a heuristic built on it would be wrong without saying so.
 */
export function parseRange(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (name: string, weight: number) => {
    out.set(name, Math.max(out.get(name) ?? 0, weight));
  };
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (!token) {
      continue;
    }
    const [body, weightText] = token.split(":");
    const weight = weightText === undefined ? 1 : Number(weightText);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new EquityInputError(`bad weight in range token: ${token}`);
    }
    for (const name of expandToken(body.trim())) {
      put(name, weight);
    }
  }
  return out;
}

function rankOf(char: string, token: string): number {
  const rank = RANK_INDEX.get(char.toUpperCase());
  if (rank === undefined) {
    throw new EquityInputError(`not a range token: ${token}`);
  }
  return rank;
}

function expandToken(token: string): string[] {
  if (token === "*" || token.toLowerCase() === "any") {
    return allClasses();
  }
  const dash = token.indexOf("-");
  if (dash > 0) {
    return expandSpan(token, token.slice(0, dash), token.slice(dash + 1));
  }
  const plus = token.endsWith("+");
  const body = plus ? token.slice(0, -1) : token;
  const high = rankOf(body[0], token);
  const low = rankOf(body[1], token);
  const suffix = body.slice(2);
  if (high < low) {
    throw new EquityInputError(`write the higher rank first: ${token}`);
  }
  if (!plus) {
    return withSuffix(high, low, suffix, token);
  }
  const out: string[] = [];
  if (high === low) {
    // 77+: every pair from here up.
    for (let rank = high; rank <= 12; rank += 1) {
      out.push(...withSuffix(rank, rank, suffix, token));
    }
    return out;
  }
  // ATs+: the kicker climbs to one below the high card.
  for (let kicker = low; kicker < high; kicker += 1) {
    out.push(...withSuffix(high, kicker, suffix, token));
  }
  return out;
}

/**
 * A span between two classes of the same shape, written in either order:
 *
 *     22-JJ, JJ-22     pairs: every pair between the two
 *     A5s-A2s          one high card, the kicker runs: A5s, A4s, A3s, A2s
 *     KTo-K8o          ... offsuit the same way
 *     T9s-65s          a fixed gap, both cards step down together
 *
 * Both ends carry the same suffix. Anything else — two different high cards
 * with two different gaps (`T9s-75s`), or a pair to a non-pair — is not a
 * span anyone means, so it throws.
 */
function expandSpan(token: string, first: string, second: string): string[] {
  const end = (part: string) => {
    if (part.length < 2) throw new EquityInputError(`not a range span: ${token}`);
    const high = rankOf(part[0], token);
    const low = rankOf(part[1], token);
    if (high < low) throw new EquityInputError(`write the higher rank first: ${token}`);
    return { high, low, suffix: part.slice(2) };
  };
  const a = end(first.trim());
  const b = end(second.trim());
  if (a.suffix !== b.suffix) {
    throw new EquityInputError(`not a range span: ${token}`);
  }
  const suffix = a.suffix;
  const out: string[] = [];
  const aPair = a.high === a.low;
  const bPair = b.high === b.low;
  if (aPair || bPair) {
    if (!(aPair && bPair)) throw new EquityInputError(`not a range span: ${token}`);
    for (let rank = Math.max(a.high, b.high); rank >= Math.min(a.high, b.high); rank -= 1) {
      out.push(...withSuffix(rank, rank, suffix, token));
    }
    return out;
  }
  if (a.high === b.high) {
    for (let kicker = Math.max(a.low, b.low); kicker >= Math.min(a.low, b.low); kicker -= 1) {
      out.push(...withSuffix(a.high, kicker, suffix, token));
    }
    return out;
  }
  if (a.high - a.low === b.high - b.low) {
    const top = a.high > b.high ? a : b;
    const steps = Math.abs(a.high - b.high);
    for (let step = 0; step <= steps; step += 1) {
      out.push(...withSuffix(top.high - step, top.low - step, suffix, token));
    }
    return out;
  }
  throw new EquityInputError(`not a range span: ${token}`);
}

function withSuffix(high: number, low: number, suffix: string, token: string): string[] {
  const name = `${RANKS[high]}${RANKS[low]}`;
  if (high === low) {
    if (suffix) {
      throw new EquityInputError(`a pair has no suit suffix: ${token}`);
    }
    return [name];
  }
  if (suffix === "s" || suffix === "o") {
    return [`${name}${suffix}`];
  }
  if (suffix === "") {
    return [`${name}s`, `${name}o`];
  }
  throw new EquityInputError(`not a range token: ${token}`);
}

/**
 * Expands class weights to combos, dropping every combo that touches a dead
 * card. The order is deterministic (map order, then suit order), which is what
 * makes a seeded sample over the result reproducible.
 */
export function rangeCombos(range: ClassWeights, dead: Iterable<number> = []): WeightedCombo[] {
  const blocked = new Set(dead);
  const out: WeightedCombo[] = [];
  for (const [name, weight] of range) {
    if (!(weight > 0)) {
      continue;
    }
    for (const cards of classCombos(name)) {
      if (!blocked.has(cards[0]) && !blocked.has(cards[1])) {
        out.push({ cards, weight: Math.min(1, weight) });
      }
    }
  }
  return out;
}

/**
 * The strongest `share` of a range on a board, by the hand each combo holds
 * *now* (5–7 cards through the evaluator), card removal applied.
 *
 * A crude stand-in for range narrowing, and only ever used in the
 * conservative direction: a player who bets the river has, at the least, a
 * range no weaker than the top part of what they could hold. Measuring a
 * hero's equity against that top part can only make it look *worse*, so a
 * heuristic that still finds the hero ahead of the price there has not been
 * flattered by an unnarrowed range. Combos are taken best first until their
 * weight reaches `share` of the total; ties at the cut all go in.
 */
export function strongestOfRange(
  range: ClassWeights,
  board: readonly string[],
  share: number,
  dead: readonly string[] = [],
): WeightedCombo[] {
  const seen = new Set<number>();
  const boardCards = board.map((code) => card(code, seen));
  if (boardCards.length < 3) {
    throw new EquityInputError("strongestOfRange needs a flop or later");
  }
  for (const code of dead) card(code, seen);
  const masks = [0, 0, 0, 0];
  for (const index of boardCards) masks[index & 3] |= 1 << (index >> 2);
  const scored = rangeCombos(range, seen).map((combo) => {
    const own = [...masks];
    own[combo.cards[0] & 3] |= 1 << (combo.cards[0] >> 2);
    own[combo.cards[1] & 3] |= 1 << (combo.cards[1] >> 2);
    return { combo, value: evaluateMasks(STANDARD, own[0], own[1], own[2], own[3]) };
  });
  scored.sort((a, b) => b.value - a.value);
  const total = scored.reduce((sum, entry) => sum + entry.combo.weight, 0);
  const out: WeightedCombo[] = [];
  let taken = 0;
  let cutValue: number | null = null;
  for (const entry of scored) {
    if (cutValue !== null && entry.value < cutValue) break;
    out.push(entry.combo);
    taken += entry.combo.weight;
    if (cutValue === null && taken >= share * total) cutValue = entry.value;
  }
  return out;
}

/** Share of the 1,326 starting combos a range holds, weights counted. */
export function rangeShare(range: ClassWeights): number {
  let total = 0;
  for (const [name, weight] of range) {
    total += classCombos(name).length * Math.min(1, Math.max(0, weight));
  }
  return total / 1326;
}

/* ---------------------------------------------------------------- equity - */

function choose(n: number, k: number): number {
  let out = 1;
  for (let i = 0; i < k; i += 1) {
    out = (out * (n - i)) / (i + 1);
  }
  return Math.round(out);
}

function card(code: string, seen: Set<number>): number {
  const index = cardIndex(code);
  if (index < 0) {
    throw new EquityInputError(`not a card: ${code}`);
  }
  if (seen.has(index)) {
    throw new EquityInputError(`${code} appears twice`);
  }
  seen.add(index);
  return index;
}

/**
 * The hero's equity against a range, over every runout of the board.
 *
 * Throws `EquityInputError` for an impossible request (a duplicated card, a
 * board of two). An opponent range that card removal empties completely is not
 * an error: it returns `combos: 0` and an equity of 1, because there is nothing
 * the hero can lose to - and the caller decides what that means.
 */
export function equityVsRange(request: RangeEquityRequest): RangeEquityResult {
  if (request.hero.length !== 2) {
    throw new EquityInputError(`the hero needs two hole cards, got ${request.hero.length}`);
  }
  const seen = new Set<number>();
  const hero = request.hero.map((code) => card(code, seen));
  const board = (request.board ?? []).map((code) => card(code, seen));
  if (board.length > 5 || board.length === 1 || board.length === 2) {
    throw new EquityInputError(`a board of ${board.length} cards is not a street`);
  }
  for (const code of request.dead ?? []) {
    card(code, seen);
  }

  const combos = isComboList(request.range)
    ? request.range.filter(({ cards: [a, b], weight }) => weight > 0 && !seen.has(a) && !seen.has(b))
    : rangeCombos(request.range, seen);
  const missing = 5 - board.length;

  if (combos.length === 0) {
    return { equity: 1, win: 1, tie: 0, combos: 0, method: "exhaustive", samples: 0 };
  }

  // Runouts per combo: the deck less the dead cards and the combo's own two.
  const runouts = choose(52 - seen.size - 2, missing);
  const method = request.method ?? "auto";
  const exhaustive =
    method === "exhaustive" ||
    (method === "auto" &&
      combos.length * runouts <= (request.exhaustiveLimit ?? DEFAULT_RANGE_EXHAUSTIVE_LIMIT));

  const heroMasks = [0, 0, 0, 0];
  for (const index of hero) heroMasks[index & 3] |= 1 << (index >> 2);
  const boardMasks = [0, 0, 0, 0];
  for (const index of board) boardMasks[index & 3] |= 1 << (index >> 2);

  let win = 0;
  let tie = 0;
  let total = 0;
  let samples = 0;

  /** Scores one complete runout for one combo; `w` is the weight to add. */
  const score = (s: number, h: number, d: number, c: number, villain: WeightedCombo, w: number) => {
    const ours = evaluateMasks(STANDARD, s | heroMasks[0], h | heroMasks[1], d | heroMasks[2], c | heroMasks[3]);
    const [a, b] = villain.cards;
    const vs = [s, h, d, c];
    vs[a & 3] |= 1 << (a >> 2);
    vs[b & 3] |= 1 << (b >> 2);
    const theirs = evaluateMasks(STANDARD, vs[0], vs[1], vs[2], vs[3]);
    if (ours > theirs) win += w;
    else if (ours === theirs) tie += w;
    total += w;
    samples += 1;
  };

  if (exhaustive) {
    for (const villain of combos) {
      const stub: number[] = [];
      for (let index = 0; index < 52; index += 1) {
        if (!seen.has(index) && index !== villain.cards[0] && index !== villain.cards[1]) {
          stub.push(index);
        }
      }
      // Each combo's runouts are weighted so that the combo as a whole counts
      // `weight`, whatever its number of runouts (they differ by card removal
      // only when the combo shares nothing - in practice they are all equal).
      const per = villain.weight / Math.max(1, choose(stub.length, missing));
      walkRunouts(stub, missing, boardMasks, (s, h, d, c) => score(s, h, d, c, villain, per));
    }
  } else {
    const random = mulberry32(request.seed ?? DEFAULT_SEED);
    const cumulative = new Float64Array(combos.length);
    let sum = 0;
    combos.forEach((combo, index) => {
      sum += combo.weight;
      cumulative[index] = sum;
    });
    const trials = Math.max(1, Math.floor(request.trials ?? DEFAULT_RANGE_TRIALS));
    const used = new Uint8Array(52);
    for (const index of seen) used[index] = 1;
    const drawn: number[] = [];
    for (let trial = 0; trial < trials; trial += 1) {
      const pick = pickWeighted(cumulative, random() * sum);
      const villain = combos[pick];
      used[villain.cards[0]] = 1;
      used[villain.cards[1]] = 1;
      const masks = [...boardMasks];
      drawn.length = 0;
      while (drawn.length < missing) {
        const index = Math.floor(random() * 52);
        if (used[index]) continue;
        used[index] = 1;
        drawn.push(index);
        masks[index & 3] |= 1 << (index >> 2);
      }
      score(masks[0], masks[1], masks[2], masks[3], villain, 1);
      for (const index of drawn) used[index] = 0;
      used[villain.cards[0]] = 0;
      used[villain.cards[1]] = 0;
    }
  }

  const winShare = total > 0 ? win / total : 0;
  const tieShare = total > 0 ? tie / total : 0;
  return {
    equity: winShare + tieShare / 2,
    win: winShare,
    tie: tieShare,
    combos: combos.length,
    method: exhaustive ? "exhaustive" : "monte-carlo",
    samples,
  };
}

function isComboList(range: RangeEquityRequest["range"]): range is readonly WeightedCombo[] {
  return Array.isArray(range);
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
