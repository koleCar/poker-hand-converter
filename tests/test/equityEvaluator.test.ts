/**
 * The hand evaluator, full deck and short deck, and the Omaha two-plus-three
 * rule.
 *
 * The fast evaluator is bit tricks over suit masks, which is exactly the kind
 * of code that is right on every hand anyone thinks to write down and wrong on
 * some hand nobody did. So besides the named hands, thousands of random hands
 * are checked against a reference written here the slow, obvious way - every
 * five-card subset, sorted ranks, counted groups - that shares no code with the
 * thing under test.
 */

import { describe, expect, it } from "vitest";

import {
  SHORT_DECK,
  STANDARD,
  categoryOf,
  cardCode,
  evaluate,
  evaluateOmaha,
  mulberry32,
  type HandCategory,
  type RankingTable,
} from "../../frontend/src/lib/equity/index.js";

/* ------------------------------------------------------------ reference - */

const STANDARD_ORDER: HandCategory[] = [
  "high-card",
  "pair",
  "two-pair",
  "trips",
  "straight",
  "flush",
  "full-house",
  "quads",
  "straight-flush",
];
const SHORT_ORDER: HandCategory[] = [
  "high-card",
  "pair",
  "two-pair",
  "straight",
  "trips",
  "full-house",
  "flush",
  "quads",
  "straight-flush",
];

interface RefHand {
  category: HandCategory;
  /** Category strength, then the tiebreak ranks: compare lexicographically. */
  key: number[];
}

/** Five cards, the slow way. */
function reference5(cards: number[], short: boolean): RefHand {
  const ranks = cards.map((card) => card >> 2).sort((a, b) => b - a);
  const flush = cards.every((card) => (card & 3) === (cards[0] & 3));
  let straightTop = -1;
  if (new Set(ranks).size === 5) {
    if (ranks[0] - ranks[4] === 4) {
      straightTop = ranks[0];
    } else if (!short && ranks.join() === "12,3,2,1,0") {
      straightTop = 3;
    } else if (short && ranks.join() === "12,7,6,5,4") {
      straightTop = 7;
    }
  }
  const counts = new Map<number, number>();
  for (const rank of ranks) {
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(([, count]) => count).join("");

  let category: HandCategory;
  if (straightTop >= 0 && flush) {
    category = "straight-flush";
  } else if (shape === "41") {
    category = "quads";
  } else if (shape === "32") {
    category = "full-house";
  } else if (flush) {
    category = "flush";
  } else if (straightTop >= 0) {
    category = "straight";
  } else if (shape === "311") {
    category = "trips";
  } else if (shape === "221") {
    category = "two-pair";
  } else if (shape === "2111") {
    category = "pair";
  } else {
    category = "high-card";
  }
  const order = short ? SHORT_ORDER : STANDARD_ORDER;
  const tiebreak = straightTop >= 0 ? [straightTop] : groups.map(([rank]) => rank);
  return { category, key: [order.indexOf(category), ...tiebreak] };
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function subsets<T>(items: T[], k: number): T[][] {
  if (k === 0) {
    return [[]];
  }
  return items.flatMap((item, i) =>
    subsets(items.slice(i + 1), k - 1).map((rest) => [item, ...rest]),
  );
}

function bestOf(hands: RefHand[]): RefHand {
  return hands.reduce((best, hand) => (compareKeys(hand.key, best.key) > 0 ? hand : best));
}

function reference(cards: number[], short: boolean): RefHand {
  return bestOf(subsets(cards, 5).map((five) => reference5(five, short)));
}

function referenceOmaha(hole: number[], board: number[]): RefHand {
  return bestOf(
    subsets(hole, 2).flatMap((two) =>
      subsets(board, 3).map((three) => reference5([...two, ...three], false)),
    ),
  );
}

/** `count` distinct random cards from the deck built of `ranks`. */
function dealer(seed: number, ranks: readonly number[]) {
  const random = mulberry32(seed);
  const deck = ranks.flatMap((rank) => [0, 1, 2, 3].map((suit) => rank * 4 + suit));
  return (count: number) => {
    for (let i = 0; i < count; i += 1) {
      const j = i + Math.floor(random() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck.slice(0, count);
  };
}

/**
 * Sorts by the fast value and checks the reference agrees on every adjacent
 * pair - same order, and equal exactly where the fast values are equal. For two
 * total preorders that is the same as agreeing on every pair.
 */
function expectSameOrder(
  values: number[],
  refs: RefHand[],
  describeHand: (i: number) => string,
): void {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  for (let n = 1; n < order.length; n += 1) {
    const lo = order[n - 1];
    const hi = order[n];
    const ref = compareKeys(refs[lo].key, refs[hi].key);
    const fast = values[hi] === values[lo] ? 0 : 1;
    if (Math.sign(ref) !== (fast === 0 ? 0 : -1)) {
      throw new Error(`order disagrees: ${describeHand(lo)} vs ${describeHand(hi)}`);
    }
  }
}

/* ---------------------------------------------------------------- tests - */

function category(cards: string, table: RankingTable = STANDARD): HandCategory {
  return categoryOf(evaluate(cards.split(" "), table), table);
}

function value(cards: string, table: RankingTable = STANDARD): number {
  return evaluate(cards.split(" "), table);
}

describe("the evaluator, full deck", () => {
  it("names every category", () => {
    expect(category("Ah Kd 9c 7s 4h 3d 2c")).toBe("high-card");
    expect(category("Ah Ad 9c 7s 4h 3d 2c")).toBe("pair");
    expect(category("Ah Ad 9c 9s 4h 3d 2c")).toBe("two-pair");
    expect(category("Ah Ad Ac 9s 4h 3d 2c")).toBe("trips");
    expect(category("Th Jd Qc Ks Ah 3d 2c")).toBe("straight");
    expect(category("2h 7h 9h Jh Kh 3d 2c")).toBe("flush");
    expect(category("Ah Ad Ac 9s 9h 3d 2c")).toBe("full-house");
    expect(category("Ah Ad Ac As 9h 3d 2c")).toBe("quads");
    expect(category("9h Th Jh Qh Kh 3d 2c")).toBe("straight-flush");
  });

  it("ranks the categories in the usual order", () => {
    const ladder = [
      "Ah Kd 9c 7s 4h",
      "2h 2d 3c 4s 6h",
      "2h 2d 3c 3s 4h",
      "2h 2d 2c 3s 4h",
      "Ah 2d 3c 4s 5h",
      "2h 3h 4h 5h 7h",
      "2h 2d 2c 3s 3h",
      "2h 2d 2c 2s 3h",
      "Ah 2h 3h 4h 5h",
    ].map((hand) => value(hand));
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
  });

  it("plays the wheel as a five-high straight", () => {
    expect(category("Ah 2d 3c 4s 5h")).toBe("straight");
    expect(value("Ah 2d 3c 4s 5h")).toBeLessThan(value("2h 3d 4c 5s 6h"));
    // ...and the steel wheel as the lowest straight flush.
    expect(value("Ah 2h 3h 4h 5h")).toBeLessThan(value("2h 3h 4h 5h 6h"));
    expect(category("Ah 2h 3h 4h 5h")).toBe("straight-flush");
  });

  it("does not wrap a straight round the ace", () => {
    expect(category("Qh Kd Ac 2s 3h")).toBe("high-card");
  });

  it("settles kickers and ties", () => {
    expect(value("Ah Ad Kc 7s 4h 3d 2c")).toBeGreaterThan(value("Ah Ad Qc 7s 4h 3d 2c"));
    // The board plays: the sixth and seventh cards are irrelevant.
    expect(value("Ah Kh Qh Jh 9d 3c 2c")).toBe(value("Ah Kh Qh Jh 9d 4c 2s"));
    // Three pairs: the third pair's rank can still be the kicker.
    expect(value("Ah Ad Kc Ks 9h 9d 2c")).toBeGreaterThan(value("Ah Ad Kc Ks 8h 8d 2c"));
    // Two trips make a full house with the lower trips as the pair.
    expect(category("Ah Ad Ac Ks Kh Kd 2c")).toBe("full-house");
    expect(value("Ah Ad Ac Ks Kh Kd 2c")).toBe(value("Ah Ad Ac Ks Kh 3d 2c"));
  });

  it("evaluates five, six and seven cards", () => {
    expect(category("Ah Ad Ac 9s 9h")).toBe("full-house");
    expect(category("Ah Ad Ac 9s 9h 2c")).toBe("full-house");
    expect(category("Ah Ad Ac 9s 9h 2c 3d")).toBe("full-house");
  });

  it("agrees with the brute-force reference on 4000 random seven-card hands", () => {
    const deal = dealer(7, STANDARD.deckRanks);
    const hands = Array.from({ length: 4000 }, () => deal(7));
    const values = hands.map((hand) => evaluate(hand));
    const refs = hands.map((hand) => reference(hand, false));
    hands.forEach((hand, i) => {
      expect(categoryOf(values[i]), hand.map(cardCode).join(" ")).toBe(refs[i].category);
    });
    expectSameOrder(values, refs, (i) => hands[i].map(cardCode).join(" "));
  });

  it("agrees with the reference on five- and six-card hands", () => {
    for (const size of [5, 6]) {
      const deal = dealer(size, STANDARD.deckRanks);
      const hands = Array.from({ length: 2000 }, () => deal(size));
      const values = hands.map((hand) => evaluate(hand));
      const refs = hands.map((hand) => reference(hand, false));
      expectSameOrder(values, refs, (i) => hands[i].map(cardCode).join(" "));
    }
  });
});

describe("the evaluator, short deck", () => {
  it("plays A-6-7-8-9 as the lowest straight", () => {
    expect(category("Ah 6d 7c 8s 9h", SHORT_DECK)).toBe("straight");
    expect(value("Ah 6d 7c 8s 9h", SHORT_DECK)).toBeLessThan(value("6h 7d 8c 9s Th", SHORT_DECK));
    expect(category("Ah 6h 7h 8h 9h", SHORT_DECK)).toBe("straight-flush");
    // The same five cards are nothing in a full deck.
    expect(category("Ah 6d 7c 8s 9h")).toBe("high-card");
  });

  it("ranks a flush over a full house", () => {
    expect(value("6h 8h Th Qh Ah", SHORT_DECK)).toBeGreaterThan(
      value("Ah Ad Ac Ks Kh", SHORT_DECK),
    );
    expect(value("6h 8h Th Qh Ah")).toBeLessThan(value("Ah Ad Ac Ks Kh"));
  });

  it("ranks three of a kind over a straight", () => {
    expect(value("6h 6d 6c 8s 9h", SHORT_DECK)).toBeGreaterThan(
      value("Th Jd Qc Ks Ah", SHORT_DECK),
    );
    expect(value("6h 6d 6c 8s 9h")).toBeLessThan(value("Th Jd Qc Ks Ah"));
  });

  it("picks the flush over the full house when seven cards make both", () => {
    // Seven cards cannot hold both, which is what lets the evaluator return a
    // flush the moment it finds one - checked here rather than assumed.
    const hand = "Ah Kh Qh 9h 6h Ad Ac";
    expect(category(hand, SHORT_DECK)).toBe("flush");
    expect(category(hand)).toBe("flush");
  });

  it("agrees with the brute-force reference on 4000 random seven-card hands", () => {
    const deal = dealer(11, SHORT_DECK.deckRanks);
    const hands = Array.from({ length: 4000 }, () => deal(7));
    const values = hands.map((hand) => evaluate(hand, SHORT_DECK));
    const refs = hands.map((hand) => reference(hand, true));
    hands.forEach((hand, i) => {
      expect(categoryOf(values[i], SHORT_DECK), hand.map(cardCode).join(" ")).toBe(
        refs[i].category,
      );
    });
    expectSameOrder(values, refs, (i) => hands[i].map(cardCode).join(" "));
  });
});

describe("Omaha", () => {
  it("needs two hearts from the hand for a flush", () => {
    const board = ["2h", "5h", "9h", "Jh", "Kc"];
    expect(categoryOf(evaluateOmaha(["Ah", "As", "Kd", "Qs"], board))).toBe("pair");
    expect(categoryOf(evaluateOmaha(["Ah", "3h", "Kd", "Qs"], board))).toBe("flush");
  });

  it("uses exactly three from the board", () => {
    // Four to a straight on board and one connector in hand is not a straight:
    // only three board cards play.
    expect(
      categoryOf(evaluateOmaha(["9c", "Qs", "Qd", "2s"], ["5h", "6c", "7d", "8s", "Kc"])),
    ).toBe("pair");
    // A board flush with no hearts in hand is no flush at all.
    expect(
      categoryOf(evaluateOmaha(["As", "Ad", "Kc", "Ks"], ["2h", "4h", "6h", "8h", "Th"])),
    ).toBe("pair");
  });

  it("agrees with the brute-force reference on random PLO and PLO5 hands", () => {
    for (const holeCount of [4, 5]) {
      const deal = dealer(holeCount * 13, STANDARD.deckRanks);
      const hands = Array.from({ length: 800 }, () => deal(holeCount + 5));
      const values = hands.map((cards) =>
        evaluateOmaha(cards.slice(0, holeCount), cards.slice(holeCount)),
      );
      const refs = hands.map((cards) =>
        referenceOmaha(cards.slice(0, holeCount), cards.slice(holeCount)),
      );
      expectSameOrder(values, refs, (i) => hands[i].map(cardCode).join(" "));
    }
  });
});
