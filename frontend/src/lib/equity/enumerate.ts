/**
 * Equity by runout: every possible board (exhaustive) or a fixed-seed sample of
 * them (Monte Carlo), for any number of players and any number of pots.
 *
 * **Pots are first-class.** A side pot is contested by a subset of the players,
 * and equity in it is computed against that subset only - a short stack's hand
 * is irrelevant to the side pot it cannot win. Rather than run one enumeration
 * per pot, every board is evaluated once for every player and then scored
 * against each pot's eligible set. The expensive part (evaluation) is shared;
 * the cheap part (a max over at most ten integers) is per pot.
 *
 * **Exact arithmetic.** A board's pot is split between the tied winners, so
 * each winner gets `1/k` of it. Shares are accumulated as integer multiples of
 * `UNIT = 27720` (the least common multiple of 1..12), which every `k` divides,
 * so an exhaustive result is an exact rational and the same on every machine.
 * The largest accumulator, 1.7M boards x 27720, is far inside 2^53.
 *
 * **Exhaustive or sampled.** `method: "auto"` enumerates whenever the work -
 * boards x evaluations per board - fits `exhaustiveLimit`, and samples
 * otherwise. The default limit is chosen so that every Hold'em spot is exact,
 * preflop included:
 *
 *     heads-up preflop    C(48,5) = 1,712,304 boards x 2 = 3.4M evaluations
 *     3-way preflop       C(46,5) = 1,370,754 boards x 3 = 4.1M
 *     6-way preflop       C(40,5) =   658,008 boards x 6 = 3.9M
 *
 * and the count peaks at four players (4.3M), so no Hold'em all-in exceeds it.
 * Measured under Node 24 on an M2 Pro: ~50ms heads-up preflop, ~70ms
 * multiway, under 2ms for any flop or turn spot.
 *
 * That makes a precomputed 169x169 table unnecessary, and such a table would
 * have been an approximation besides: it stores the average over suit
 * combinations, and `AhKh` against `QhQd` is not `AKs` against `QQ` on
 * average. What does exceed the limit is preflop Omaha (a PLO board costs 60
 * evaluations per player; enumerating one heads-up takes ~1.5s), which is
 * sampled with a seeded `mulberry32` - ~35ms for the default 20,000 boards -
 * so a given request always returns the same numbers.
 */

import { cardIndex, evaluateMasks, SHORT_DECK, STANDARD, type RankingTable } from "./evaluator";
import { evaluateOmahaMasks, holePairMasks } from "./omaha";

/** The games this module can evaluate. Hi/lo, stud and draw are not among them. */
export type EquityGame = "holdem" | "shortdeck" | "omaha" | "omaha5" | "omaha6";

export interface EquityRequest {
  game: EquityGame;
  /** Hole cards per player, as codes like `"Ah"`. */
  hands: readonly (readonly string[])[];
  /** Board cards already dealt: 0, 3, 4 or 5 of them. */
  board?: readonly string[];
  /** Cards known to be out of the deck that no player holds. */
  dead?: readonly string[];
  /**
   * The pots, each as the indices (into `hands`) of the players eligible for
   * it. Defaults to one pot that everybody is in.
   */
  pots?: readonly (readonly number[])[];
  /** Defaults to `"auto"`: exhaustive when it fits `exhaustiveLimit`. */
  method?: "auto" | "exhaustive" | "monte-carlo";
  /** Boards x evaluations-per-board that `"auto"` will still enumerate. */
  exhaustiveLimit?: number;
  /** Monte Carlo boards. */
  trials?: number;
  /** Monte Carlo seed. The same seed and request always give the same result. */
  seed?: number;
}

export interface EquityResult {
  /**
   * `pots[p][i]` is player `i`'s share of pot `p`, in [0, 1]. Each row sums to
   * 1 across the pot's eligible players and is 0 for everyone else.
   */
  pots: number[][];
  /** `pots[0]`, which is the whole answer when there is one pot. */
  equity: number[];
  method: "exhaustive" | "monte-carlo";
  /** Boards enumerated or sampled. */
  boards: number;
}

export const DEFAULT_EXHAUSTIVE_LIMIT = 5_000_000;
export const DEFAULT_TRIALS = 20_000;
export const DEFAULT_SEED = 0x5eed;

/** Thrown for a request that is not a dealable situation. */
export class EquityInputError extends Error {}

const UNIT = 27720;
const MAX_PLAYERS = 12;
const SHARE = new Float64Array(MAX_PLAYERS + 1);
for (let k = 1; k <= MAX_PLAYERS; k += 1) {
  SHARE[k] = UNIT / k;
}

/** Hole-card count each game deals. */
export function holeCardsFor(game: EquityGame): number {
  switch (game) {
    case "holdem":
    case "shortdeck":
      return 2;
    case "omaha":
      return 4;
    case "omaha5":
      return 5;
    case "omaha6":
      return 6;
  }
}

/** The ranking table a game is scored with. */
export function tableFor(game: EquityGame): RankingTable {
  return game === "shortdeck" ? SHORT_DECK : STANDARD;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) {
    return 0;
  }
  let out = 1;
  for (let i = 0; i < k; i += 1) {
    out = (out * (n - i)) / (i + 1);
  }
  return Math.round(out);
}

/**
 * Deterministic PRNG: 32 bits of state, uniform output in [0, 1). Not
 * cryptographic and does not need to be - it only needs to be the same on
 * every run and good enough that a few thousand boards are representative.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Prepared {
  table: RankingTable;
  omaha: boolean;
  /** Hold'em: four suit masks per player. */
  holeMasks: Int32Array;
  /** Omaha: the hole-pair masks per player. */
  pairMasks: Int32Array[];
  boardCards: number[];
  boardMasks: [number, number, number, number];
  /** Undealt cards that can still come. */
  stub: number[];
  pots: number[][];
  players: number;
}

function prepare(request: EquityRequest): Prepared {
  const table = tableFor(request.game);
  const holeCount = holeCardsFor(request.game);
  const players = request.hands.length;
  if (players < 1 || players > MAX_PLAYERS) {
    throw new EquityInputError(`need 1-${MAX_PLAYERS} players, got ${players}`);
  }

  const seen = new Set<number>();
  const deckRanks = new Set(table.deckRanks);
  const take = (code: string): number => {
    const index = cardIndex(code);
    if (index < 0) {
      throw new EquityInputError(`not a card: ${code}`);
    }
    if (!deckRanks.has(index >> 2)) {
      throw new EquityInputError(`${code} is not in a ${table.name} deck`);
    }
    if (seen.has(index)) {
      throw new EquityInputError(`${code} appears twice`);
    }
    seen.add(index);
    return index;
  };

  const hands = request.hands.map((hand, i) => {
    if (hand.length !== holeCount) {
      throw new EquityInputError(
        `player ${i} has ${hand.length} hole cards, ${request.game} deals ${holeCount}`,
      );
    }
    return hand.map(take);
  });
  const boardCards = (request.board ?? []).map(take);
  if (boardCards.length > 5 || boardCards.length === 1 || boardCards.length === 2) {
    throw new EquityInputError(`a board of ${boardCards.length} cards is not a street`);
  }
  (request.dead ?? []).forEach(take);

  const pots = (request.pots ?? [hands.map((_, i) => i)]).map((pot) => {
    const eligible = [...new Set(pot)].sort((a, b) => a - b);
    if (
      eligible.length === 0 ||
      eligible.some((i) => !Number.isInteger(i) || i < 0 || i >= players)
    ) {
      throw new EquityInputError("every pot needs at least one eligible player, by index");
    }
    return eligible;
  });

  const stub: number[] = [];
  for (const rank of table.deckRanks) {
    for (let suit = 0; suit < 4; suit += 1) {
      const card = rank * 4 + suit;
      if (!seen.has(card)) {
        stub.push(card);
      }
    }
  }
  if (stub.length < 5 - boardCards.length) {
    throw new EquityInputError("not enough cards left to complete the board");
  }

  const omaha = holeCount > 2;
  const holeMasks = new Int32Array(players * 4);
  hands.forEach((hand, i) => {
    for (const card of hand) {
      holeMasks[i * 4 + (card & 3)] |= 1 << (card >> 2);
    }
  });
  const boardMasks: [number, number, number, number] = [0, 0, 0, 0];
  for (const card of boardCards) {
    boardMasks[card & 3] |= 1 << (card >> 2);
  }

  return {
    table,
    omaha,
    holeMasks,
    pairMasks: omaha ? hands.map(holePairMasks) : [],
    boardCards,
    boardMasks,
    stub,
    pots,
    players,
  };
}

/** Scores one complete board, given as the suit masks of all five cards. */
type Scorer = (s: number, h: number, d: number, c: number) => void;

/**
 * Builds the per-board scorer, accumulating into `acc`.
 *
 * A closure over the prepared request so the per-board path touches only typed
 * arrays and locals. Hold'em needs nothing but the board's masks. Omaha also
 * needs the board's individual cards, to form its triples; the walkers keep
 * the undealt part of the board in `runout` for that.
 */
function boardScorer(prep: Prepared, runout: Int32Array): { score: Scorer; acc: Float64Array } {
  const { table, omaha, holeMasks, pairMasks, boardCards, pots, players } = prep;
  const values = new Int32Array(players);
  const acc = new Float64Array(pots.length * players);
  const known = boardCards.length;
  const cards = new Int32Array(5);
  for (let i = 0; i < known; i += 1) {
    cards[i] = boardCards[i];
  }
  const triples = new Int32Array(40);
  const flatPots = pots.map((pot) => Int32Array.from(pot));

  // Splits each pot between its best eligible hands. Shared by both scorers.
  const award = () => {
    for (let p = 0; p < flatPots.length; p += 1) {
      const eligible = flatPots[p];
      let best = -1;
      let winners = 0;
      for (let e = 0; e < eligible.length; e += 1) {
        const value = values[eligible[e]];
        if (value > best) {
          best = value;
          winners = 1;
        } else if (value === best) {
          winners += 1;
        }
      }
      const share = SHARE[winners];
      const row = p * players;
      for (let e = 0; e < eligible.length; e += 1) {
        if (values[eligible[e]] === best) {
          acc[row + eligible[e]] += share;
        }
      }
    }
  };

  if (!omaha && players === 2 && flatPots.length === 1 && flatPots[0].length === 2) {
    // Heads-up for one pot: the shape of most all-ins, and the hot path of a
    // preflop one. Comparing two values directly instead of going through
    // `award` takes about a third off its running time.
    const half = UNIT / 2;
    const score: Scorer = (s, h, d, c) => {
      const a = evaluateMasks(
        table,
        s | holeMasks[0],
        h | holeMasks[1],
        d | holeMasks[2],
        c | holeMasks[3],
      );
      const b = evaluateMasks(
        table,
        s | holeMasks[4],
        h | holeMasks[5],
        d | holeMasks[6],
        c | holeMasks[7],
      );
      if (a > b) {
        acc[0] += UNIT;
      } else if (b > a) {
        acc[1] += UNIT;
      } else {
        acc[0] += half;
        acc[1] += half;
      }
    };
    return { score, acc };
  }

  if (!omaha) {
    const score: Scorer = (s, h, d, c) => {
      for (let i = 0, m = 0; i < players; i += 1, m += 4) {
        values[i] = evaluateMasks(
          table,
          s | holeMasks[m],
          h | holeMasks[m + 1],
          d | holeMasks[m + 2],
          c | holeMasks[m + 3],
        );
      }
      award();
    };
    return { score, acc };
  }

  const score: Scorer = () => {
    for (let i = known; i < 5; i += 1) {
      cards[i] = runout[i - known];
    }
    let t = 0;
    for (let a = 0; a < 5; a += 1) {
      for (let b = a + 1; b < 5; b += 1) {
        for (let e = b + 1; e < 5; e += 1) {
          triples[t] = 0;
          triples[t + 1] = 0;
          triples[t + 2] = 0;
          triples[t + 3] = 0;
          triples[t + (cards[a] & 3)] |= 1 << (cards[a] >> 2);
          triples[t + (cards[b] & 3)] |= 1 << (cards[b] >> 2);
          triples[t + (cards[e] & 3)] |= 1 << (cards[e] >> 2);
          t += 4;
        }
      }
    }
    for (let i = 0; i < players; i += 1) {
      values[i] = evaluateOmahaMasks(table, pairMasks[i], triples);
    }
    award();
  };
  return { score, acc };
}

/** One card's contribution to the four suit masks, four ints per stub card. */
function stubMasks(stub: number[]): Int32Array {
  const out = new Int32Array(stub.length * 4);
  stub.forEach((card, i) => {
    out[i * 4 + (card & 3)] = 1 << (card >> 2);
  });
  return out;
}

/**
 * Every completion of the board, in lexicographic order. Returns the count.
 *
 * Nested loops, one level per missing card, each OR-ing its card into the
 * masks it was handed: the innermost level, which runs once per board, does
 * four ORs and the scoring and nothing else. That shape is what brings a
 * heads-up preflop all-in (1.7M boards) to tens of milliseconds; recomputing
 * the masks from a combination array per board was about 40% slower.
 */
function exhaustive(prep: Prepared, runout: Int32Array, score: Scorer): number {
  const stub = prep.stub;
  const masks = stubMasks(stub);
  const n = stub.length;
  const k = 5 - prep.boardCards.length;
  const [s0, h0, d0, c0] = prep.boardMasks;
  if (k === 0) {
    score(s0, h0, d0, c0);
    return 1;
  }
  let boards = 0;
  const walk = (depth: number, from: number, s: number, h: number, d: number, c: number): void => {
    if (depth === k - 1) {
      for (let i = from, m = from * 4; i < n; i += 1, m += 4) {
        runout[depth] = stub[i];
        score(s | masks[m], h | masks[m + 1], d | masks[m + 2], c | masks[m + 3]);
      }
      boards += n - from;
      return;
    }
    for (let i = from, m = from * 4; i <= n - (k - depth); i += 1, m += 4) {
      runout[depth] = stub[i];
      walk(depth + 1, i + 1, s | masks[m], h | masks[m + 1], d | masks[m + 2], c | masks[m + 3]);
    }
  };
  walk(0, 0, s0, h0, d0, c0);
  return boards;
}

/**
 * `trials` uniformly random completions of the board.
 *
 * A partial Fisher-Yates over a working copy of the stub: the first k slots
 * after k swaps are a uniform k-subset whatever order the array started in, so
 * the copy is never reset between trials.
 */
function monteCarlo(
  prep: Prepared,
  runout: Int32Array,
  score: Scorer,
  trials: number,
  seed: number,
): number {
  const deck = Int32Array.from(prep.stub);
  const n = deck.length;
  const k = 5 - prep.boardCards.length;
  const random = mulberry32(seed);
  for (let t = 0; t < trials; t += 1) {
    let [s, h, d, c] = prep.boardMasks;
    for (let i = 0; i < k; i += 1) {
      const j = i + Math.floor(random() * (n - i));
      const card = deck[j];
      deck[j] = deck[i];
      deck[i] = card;
      runout[i] = card;
      const bit = 1 << (card >> 2);
      switch (card & 3) {
        case 0:
          s |= bit;
          break;
        case 1:
          h |= bit;
          break;
        case 2:
          d |= bit;
          break;
        default:
          c |= bit;
      }
    }
    score(s, h, d, c);
  }
  return trials;
}

/** Evaluations one board costs for this request. */
function evaluationsPerBoard(prep: Prepared): number {
  if (!prep.omaha) {
    return prep.players;
  }
  return prep.pairMasks.reduce((sum, pairs) => sum + (pairs.length / 4) * 10, 0);
}

/** How a request would be computed, without computing it. */
export function plan(request: EquityRequest): {
  method: "exhaustive" | "monte-carlo";
  boards: number;
  evaluations: number;
} {
  const prep = prepare(request);
  return planPrepared(prep, request);
}

function planPrepared(
  prep: Prepared,
  request: EquityRequest,
): { method: "exhaustive" | "monte-carlo"; boards: number; evaluations: number } {
  const boards = choose(prep.stub.length, 5 - prep.boardCards.length);
  const perBoard = evaluationsPerBoard(prep);
  const method = request.method ?? "auto";
  if (
    method === "exhaustive" ||
    (method === "auto" &&
      boards * perBoard <= (request.exhaustiveLimit ?? DEFAULT_EXHAUSTIVE_LIMIT))
  ) {
    return { method: "exhaustive", boards, evaluations: boards * perBoard };
  }
  const trials = Math.max(1, Math.floor(request.trials ?? DEFAULT_TRIALS));
  return { method: "monte-carlo", boards: trials, evaluations: trials * perBoard };
}

/**
 * Each player's share of each pot over every runout of the board.
 *
 * Throws `EquityInputError` for an impossible request: a duplicated card, the
 * wrong number of hole cards, a deuce in a short-deck hand.
 */
export function equity(request: EquityRequest): EquityResult {
  const prep = prepare(request);
  const planned = planPrepared(prep, request);
  const runout = new Int32Array(5 - prep.boardCards.length);
  const { score, acc } = boardScorer(prep, runout);
  const boards =
    planned.method === "exhaustive"
      ? exhaustive(prep, runout, score)
      : monteCarlo(prep, runout, score, planned.boards, request.seed ?? DEFAULT_SEED);

  const pots = prep.pots.map((_, p) => {
    const row: number[] = [];
    for (let i = 0; i < prep.players; i += 1) {
      row.push(acc[p * prep.players + i] / (boards * UNIT));
    }
    return row;
  });
  return { pots, equity: pots[0], method: planned.method, boards };
}
