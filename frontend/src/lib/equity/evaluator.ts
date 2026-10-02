/**
 * Five-, six- and seven-card poker hand evaluation, for full deck and short deck.
 *
 * **Representation.** A card is an integer `rank * 4 + suit`, rank 0..12 for
 * 2..A and suit 0..3 for s, h, d, c. A *hand* is four 13-bit rank masks, one per
 * suit. Masks are what make this fast: the rank set is the OR of the four, the
 * quads are their AND, and every remaining question - "is there a straight",
 * "which five ranks play" - is one lookup into an 8192-entry table. There is no
 * sorting and no allocation on the hot path, which is the path the enumerator
 * calls a few million times per preflop all-in.
 *
 * **Value.** `evaluateMasks` returns an integer where higher beats lower and
 * equal ties: `strength << 20` followed by five 4-bit rank nibbles, most
 * significant first. Values are only comparable between hands evaluated with
 * the same table and the same card count, which is the only comparison an
 * equity calculation ever makes.
 *
 * **Short deck is two more tables, not a flag.** It differs from the full deck
 * in two facts, and both are data:
 *
 *  - which rank sets are straights (`A-6-7-8-9` is the lowest, `A-2-3-4-5` cannot
 *    be dealt), and
 *  - the order of the categories: a flush beats a full house everywhere, and
 *    where three of a kind and a straight fall depends on the room.
 *
 * The rooms disagree on that last point, so there are two short-deck tables
 * and `SHORT_DECK_RULE_BY_SITE` below picks one per room:
 *
 *  - `SHORT_DECK` - three of a kind over a straight, the classic (original
 *    Triton) rule. The default for every room whose own payouts have not
 *    said otherwise.
 *  - `SHORT_DECK_STRAIGHT_OVER_TRIPS` - a straight over three of a kind, which
 *    is what GGPoker pays. See the map for the evidence.
 *
 * The evaluation order below is valid for any table because of one card-count
 * fact: with at most seven cards, a flush leaves at most two other cards, which
 * can make neither a full house nor quads. So a flush is final, quads are final,
 * a full house is final, and the only categories that can coexist and need the
 * table's order to settle them are a straight and three of a kind (or a weaker
 * pair holding).
 */

import { parseCard, rankValue } from "../cards";

/* ---------------------------------------------------------------- cards - */

const SUITS = "shdc";
const RANK_CHARS = "23456789TJQKA";

/** Card index for a code like `"Ah"`, or -1 for anything that is not a card. */
export function cardIndex(code: string): number {
  const card = parseCard(code);
  if (!card) {
    return -1;
  }
  return rankValue(card.rank) * 4 + SUITS.indexOf(card.suit);
}

/** Card code for an index produced by `cardIndex`. */
export function cardCode(index: number): string {
  return `${RANK_CHARS[index >> 2]}${SUITS[index & 3]}`;
}

/* ------------------------------------------------------------ categories - */

export const HAND_CATEGORIES = [
  "high-card",
  "pair",
  "two-pair",
  "trips",
  "straight",
  "flush",
  "full-house",
  "quads",
  "straight-flush",
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

const HIGH_CARD = 0;
const PAIR = 1;
const TWO_PAIR = 2;
const TRIPS = 3;
const STRAIGHT = 4;
const FLUSH = 5;
const FULL_HOUSE = 6;
const QUADS = 7;
const STRAIGHT_FLUSH = 8;

/* --------------------------------------------------------------- tables - */

/** Bits set in a 13-bit mask. */
const POP = new Uint8Array(8192);
/** Index of the highest set bit, or 0 for an empty mask (never read for one). */
const TOP = new Uint8Array(8192);
/** The five highest ranks of a mask packed as nibbles, highest at bits 16-19. */
const TOP5 = new Int32Array(8192);

for (let mask = 1; mask < 8192; mask += 1) {
  POP[mask] = POP[mask >> 1] + (mask & 1);
  TOP[mask] = 31 - Math.clz32(mask);
  let packed = 0;
  let rest = mask;
  for (let i = 0; i < 5; i += 1) {
    const top = rest ? 31 - Math.clz32(rest) : 0;
    packed = (packed << 4) | top;
    rest &= ~(1 << top);
  }
  TOP5[mask] = packed;
}

/**
 * Everything that distinguishes one game's hand ranking from another's.
 *
 * `straight[mask]` is one more than the top rank of the best straight in the
 * rank set, or 0 for none. `shift[category]` is the category's strength,
 * already shifted into place, so a value is built with one OR.
 */
export interface RankingTable {
  readonly name: "standard" | "short-deck" | "short-deck-straight-over-trips";
  /** Ranks the deck is built from, low to high (0 = deuce). */
  readonly deckRanks: readonly number[];
  readonly straight: Uint8Array;
  readonly shift: Int32Array;
  /** Category for each strength, the inverse of `shift`. */
  readonly byStrength: readonly HandCategory[];
}

/** Five ranks that make a straight, and the rank it plays as. */
interface StraightWindow {
  ranks: number[];
  top: number;
}

function straightTable(windows: StraightWindow[]): Uint8Array {
  const table = new Uint8Array(8192);
  // Highest window first, so the first match is the best straight.
  const ordered = windows
    .map(({ ranks, top }) => ({ need: ranks.reduce((acc, rank) => acc | (1 << rank), 0), top }))
    .sort((a, b) => b.top - a.top);
  for (let mask = 0; mask < 8192; mask += 1) {
    for (const window of ordered) {
      if ((mask & window.need) === window.need) {
        table[mask] = window.top + 1;
        break;
      }
    }
  }
  return table;
}

function rankingTable(
  name: RankingTable["name"],
  deckRanks: number[],
  windows: StraightWindow[],
  order: HandCategory[],
): RankingTable {
  const shift = new Int32Array(HAND_CATEGORIES.length);
  HAND_CATEGORIES.forEach((category, index) => {
    shift[index] = order.indexOf(category) << 20;
  });
  return { name, deckRanks, straight: straightTable(windows), shift, byStrength: order };
}

/** Five consecutive ranks ending at each top from `lowTop` to the ace. */
function runs(lowTop: number): StraightWindow[] {
  const out: StraightWindow[] = [];
  for (let top = lowTop; top <= 12; top += 1) {
    out.push({ ranks: [top - 4, top - 3, top - 2, top - 1, top], top });
  }
  return out;
}

/** Full 52-card deck: the wheel is A-2-3-4-5, played as a five-high straight. */
export const STANDARD: RankingTable = rankingTable(
  "standard",
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  [{ ranks: [12, 0, 1, 2, 3], top: 3 }, ...runs(4)],
  [
    "high-card",
    "pair",
    "two-pair",
    "trips",
    "straight",
    "flush",
    "full-house",
    "quads",
    "straight-flush",
  ],
);

/** 36-card deck, sixes to aces: A-6-7-8-9 is the low straight, played nine-high. */
export const SHORT_DECK: RankingTable = rankingTable(
  "short-deck",
  [4, 5, 6, 7, 8, 9, 10, 11, 12],
  [{ ranks: [12, 4, 5, 6, 7], top: 7 }, ...runs(8)],
  [
    "high-card",
    "pair",
    "two-pair",
    "straight",
    "trips",
    "full-house",
    "flush",
    "quads",
    "straight-flush",
  ],
);

/**
 * The same 36-card deck as `SHORT_DECK`, with a straight over three of a kind.
 * A flush still beats a full house.
 */
export const SHORT_DECK_STRAIGHT_OVER_TRIPS: RankingTable = rankingTable(
  "short-deck-straight-over-trips",
  [4, 5, 6, 7, 8, 9, 10, 11, 12],
  [{ ranks: [12, 4, 5, 6, 7], top: 7 }, ...runs(8)],
  [
    "high-card",
    "pair",
    "two-pair",
    "trips",
    "straight",
    "full-house",
    "flush",
    "quads",
    "straight-flush",
  ],
);

/** Where a room ranks three of a kind against a straight in short deck. */
export type ShortDeckRule = "trips-over-straight" | "straight-over-trips";

/**
 * The short-deck rule per room, keyed by `meta.siteId`. The one place this is
 * decided; a room that is not listed gets `trips-over-straight`.
 *
 * A room goes on this map only on the evidence of its own payouts, the same
 * bar the parsers' variant locks hold to:
 *
 *  - **`ggpoker`: straight over trips.** `fixtures/samples/ggpoker/12-...`,
 *    first board `Tc 8h Ah 6h Jd`: `Qs Ks` makes an ace-high straight, `Td Ts`
 *    makes three tens, and GG paid the straight (`951600 ... won ($1,354) with
 *    Aces-High Straight`, `1802531 ... lost with Three Tens`).
 *
 * ACR's one Six Plus hand never reaches a showdown, so it says nothing, and
 * ACR keeps the default with every other room until a fixture of its own does.
 */
export const SHORT_DECK_RULE_BY_SITE: Readonly<Record<string, ShortDeckRule>> = {
  ggpoker: "straight-over-trips",
};

/** The short-deck rule for a room; the classic one unless the map says otherwise. */
export function shortDeckRuleFor(siteId: string): ShortDeckRule {
  return SHORT_DECK_RULE_BY_SITE[siteId.trim().toLowerCase()] ?? "trips-over-straight";
}

/** The ranking table a short-deck rule is scored with. */
export function shortDeckTable(rule: ShortDeckRule = "trips-over-straight"): RankingTable {
  return rule === "straight-over-trips" ? SHORT_DECK_STRAIGHT_OVER_TRIPS : SHORT_DECK;
}

/* ------------------------------------------------------------ evaluator - */

/**
 * Value of the best five-card hand in the cards described by four suit masks.
 *
 * The hot path. Callers that enumerate keep the masks themselves and OR the
 * board in; `evaluate` is the convenience wrapper for everyone else.
 */
export function evaluateMasks(
  table: RankingTable,
  s: number,
  h: number,
  d: number,
  c: number,
): number {
  const shift = table.shift;

  const flush = POP[s] >= 5 ? s : POP[h] >= 5 ? h : POP[d] >= 5 ? d : POP[c] >= 5 ? c : 0;
  if (flush) {
    const straight = table.straight[flush];
    if (straight) {
      return shift[STRAIGHT_FLUSH] | ((straight - 1) << 16);
    }
    return shift[FLUSH] | TOP5[flush];
  }

  const ranks = s | h | d | c;
  const quads = s & h & d & c;
  if (quads) {
    const quad = TOP[quads];
    return shift[QUADS] | (quad << 16) | (TOP[ranks ^ (1 << quad)] << 12);
  }

  // Ranks held an odd number of times (once or three times), then the ranks
  // held in at least three suits. With quads excluded the latter is exactly
  // the trips, and what is in `ranks` but not `odd` is exactly the pairs.
  const odd = s ^ h ^ d ^ c;
  const trips = ((s & h) | (d & c)) & ((s & d) | (h & c));
  const pairs = ranks & ~odd;

  if (trips) {
    const trip = TOP[trips];
    const filler = (trips ^ (1 << trip)) | pairs;
    if (filler) {
      return shift[FULL_HOUSE] | (trip << 16) | (TOP[filler] << 12);
    }
  }

  const straight = table.straight[ranks];
  const straightValue = straight ? shift[STRAIGHT] | ((straight - 1) << 16) : 0;

  let made: number;
  if (trips) {
    const trip = TOP[trips];
    made = shift[TRIPS] | (trip << 16) | (TOP5[ranks ^ (1 << trip)] >> 12);
  } else if (POP[pairs] >= 2) {
    const high = TOP[pairs];
    const low = TOP[pairs ^ (1 << high)];
    const kicker = TOP[ranks ^ (1 << high) ^ (1 << low)];
    made = shift[TWO_PAIR] | (high << 16) | (low << 12) | (kicker << 8);
  } else if (pairs) {
    const pair = TOP[pairs];
    made = shift[PAIR] | (pair << 16) | (TOP5[ranks ^ (1 << pair)] >> 8);
  } else {
    made = shift[HIGH_CARD] | TOP5[ranks];
  }
  return straightValue > made ? straightValue : made;
}

/** Suit masks for a list of card indices, as `[s, h, d, c]`. */
export function suitMasks(cards: readonly number[]): [number, number, number, number] {
  const masks: [number, number, number, number] = [0, 0, 0, 0];
  for (const card of cards) {
    masks[card & 3] |= 1 << (card >> 2);
  }
  return masks;
}

/**
 * Value of the best five-card hand among 5 to 7 cards.
 *
 * Accepts card indices or codes. Throws on an invalid code, because a caller
 * that got this far with junk has a bug the evaluator should not paper over.
 */
export function evaluate(
  cards: readonly (number | string)[],
  table: RankingTable = STANDARD,
): number {
  const indices = cards.map((card) => {
    const index = typeof card === "number" ? card : cardIndex(card);
    if (index < 0 || index > 51) {
      throw new Error(`not a card: ${String(card)}`);
    }
    return index;
  });
  const [s, h, d, c] = suitMasks(indices);
  return evaluateMasks(table, s, h, d, c);
}

/** The category a value belongs to under `table`. */
export function categoryOf(value: number, table: RankingTable = STANDARD): HandCategory {
  return table.byStrength[value >> 20];
}
