import { describe, expect, it } from "vitest";

import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

/** Parse, re-serialize, and demand the bytes back. */
function roundTrip(text: string): string {
  return toStandardText(parse(text));
}

/**
 * Presentation varies per room and none of it changes what a hand means, but
 * Holdem Manager and PokerTracker import this text and are byte sensitive, so
 * every one of these has to survive a trip through PHF.
 *
 * The fields backing these are optional on `PhfTextStyle` and recovered from
 * `meta.rawText` when a parser leaves them unset - see `resolveTextStyle`.
 * That is what lets eleven hand-written parsers inherit the behaviour without
 * each of them having to opt in.
 */

const GROUPED = `Poker Hand #TM1: Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600) - 2021/04/04 20:43:56
Table '137' 8-max Seat #2 is the button
Seat 1: alpha (21,929 in chips)
Seat 2: bravo (46,372 in chips)
alpha: posts the ante 75
bravo: posts the ante 75
bravo: posts small blind 300
alpha: posts big blind 600
*** HOLE CARDS ***
Dealt to alpha
Dealt to bravo [Kc Jc]
bravo: raises 600 to 1,200
alpha: folds
Uncalled bet (600) returned to bravo
*** SHOWDOWN ***
bravo: doesn't show hand
bravo collected 1,350 from pot
*** SUMMARY ***
Total pot 1,350
Seat 1: alpha (big blind) folded before Flop
Seat 2: bravo (button) (small blind) collected (1,350)`;

describe("thousands separators", () => {
  it("round-trips grouped amounts everywhere they appear", () => {
    // Stacks, raises, uncalled returns, collects and the pot line all group.
    expect(roundTrip(GROUPED)).toBe(GROUPED);
  });

  it("reads grouped digits as the number, not as something smaller", () => {
    const hand = parse(GROUPED);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.players.find((p) => p.name === "alpha")?.startingStack).toBe(21929);
    expect(hand.results.totalPot).toBe(1350);
    const raise = hand.actions.find((a) => a.type === "raise")!;
    expect(raise.streetTotal).toBe(1200);
  });

  it("leaves ungrouped sources ungrouped", () => {
    const plain = GROUPED.replace(/,(\d{3})/g, "$1");
    expect(roundTrip(plain)).toBe(plain);
    // Digit grouping specifically; the comma after the tournament id stays.
    expect(roundTrip(plain)).not.toMatch(/\d,\d{3}/);
  });

  it("can be pinned explicitly, overriding what the source did", () => {
    const hand = parse(GROUPED);
    hand.meta.textStyle.groupThousands = false;
    expect(toStandardText(hand)).toContain("Seat 1: alpha (21929 in chips)");
  });
});

describe("the tournament header dialects", () => {
  it("round-trips GG's inline name, glued level and incidental spacing", () => {
    // GG puts a free-text name (buy-in text and all) between the id and the
    // game label, numbers levels in arabic glued to the word, and slips a
    // triple space in before the level clause.
    expect(roundTrip(GROUPED)).toContain(
      "Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)",
    );
    const hand = parse(GROUPED);
    expect(hand.tournament?.id).toBe("25313426");
    expect(hand.tournament?.levelLabel).toBe("14");
    expect(hand.tournament?.levelSmallBlind).toBe(300);
    expect(hand.tournament?.levelBigBlind).toBe(600);
    expect(hand.game.label).toBe("Hold'em No Limit");
    expect(hand.game.unit.kind).toBe("chips");
  });

  it("splits the name from the game label by the label, not by the buy-in", () => {
    const hand = parse(GROUPED.replace("H-04: $1,050 GGMasters High Rollers", "Daily Special $250"));
    expect(hand.tournament?.name).toBe("Daily Special $250");
    expect(hand.game.label).toBe("Hold'em No Limit");
  });

  it("still round-trips the parenthesised-name dialect", () => {
    const weplay = GROUPED.replace(
      "Tournament #25313426, H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)",
      "Tournament (Chocolate Box Deepstack)#11275291, $15+$1.50 Hold'em No Limit - Level XI (300/600)",
    );
    expect(roundTrip(weplay)).toBe(weplay);
    const hand = parse(weplay);
    expect(hand.tournament?.name).toBe("Chocolate Box Deepstack");
    expect(hand.tournament?.buyIn).toBe(1500);
    expect(hand.tournament?.fee).toBe(150);
  });

  it("never invents a +$0 fee the room did not print", () => {
    const single = GROUPED.replace(
      "H-04: $1,050 GGMasters High Rollers Hold'em No Limit   - Level14(300/600)",
      "Daily Special $55 Hold'em No Limit - Level2 (300/600)",
    );
    expect(roundTrip(single)).toBe(single);
    expect(roundTrip(single)).not.toContain("+$0");
  });
});

describe("the fee columns on the pot line", () => {
  it("echoes a bare pot with no columns at all", () => {
    expect(roundTrip(GROUPED)).toContain("\nTotal pot 1,350\n");
  });

  it("echoes a partial column set", () => {
    const partial = GROUPED.replace("Total pot 1,350", "Total pot 1,350 | Rake 0 | Jackpot 0");
    expect(roundTrip(partial)).toContain("Total pot 1,350 | Rake 0 | Jackpot 0\n");
  });

  it("keeps the full GG cash set", () => {
    const full = GROUPED.replace(
      "Total pot 1,350",
      "Total pot 1,350 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0",
    );
    expect(roundTrip(full)).toBe(full);
  });
});

describe("the empty deal line", () => {
  it("echoes a source that writes no trailing space", () => {
    expect(roundTrip(GROUPED)).toContain("\nDealt to alpha\n");
  });

  it("echoes a source that writes one", () => {
    const spaced = GROUPED.replace("Dealt to alpha\n", "Dealt to alpha \n");
    expect(roundTrip(spaced)).toContain("\nDealt to alpha \n");
  });
});

const BARE_STRADDLE = `Poker Hand #RC1: Hold'em No Limit ($0.01/$0.02) - 2021/03/01 10:00:00
Table 'RushAndCash1' 6-max Seat #1 is the button
Seat 1: alpha ($2 in chips)
Seat 2: bravo ($2 in chips)
Seat 3: Hero ($2 in chips)
bravo: posts small blind $0.01
Hero: posts big blind $0.02
alpha: straddle $0.04
*** HOLE CARDS ***
Dealt to alpha
Dealt to bravo
Dealt to Hero [Ac Kh]
bravo: folds
Hero: folds
Uncalled bet ($0.02) returned to alpha
*** SHOWDOWN ***
alpha: doesn't show hand
alpha collected $0.05 from pot
*** SUMMARY ***
Total pot $0.05 | Rake $0
Seat 1: alpha (button) collected ($0.05)
Seat 2: bravo (small blind) folded before Flop
Seat 3: Hero (big blind) folded before Flop`;

describe("straddle verbs", () => {
  it("reads GG's bare `straddle`, which has no `posts`", () => {
    // The serializer always wrote this correctly; the parser could not read its
    // own output back, so the straddle - and its chips - silently vanished on a
    // round trip and the hand still balanced against itself afterwards.
    const hand = parse(BARE_STRADDLE);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.game.straddles).toEqual([
      { seat: 1, player: "alpha", amount: 4, order: 1 },
    ]);
    const straddle = hand.actions.find((action) => action.type === "straddle")!;
    expect(straddle.amount).toBe(4);
    expect(straddle.verb).toBe("straddle");
    expect(roundTrip(BARE_STRADDLE)).toBe(BARE_STRADDLE);
  });

  it("still reads `posts straddle` and a plain `posts`", () => {
    const posts = BARE_STRADDLE.replace("alpha: straddle $0.04", "alpha: posts straddle $0.04");
    const hand = parse(posts);
    expect(hand.actions.find((a) => a.type === "straddle")?.verb).toBe("posts straddle");
    expect(roundTrip(posts)).toBe(posts);

    const dead = BARE_STRADDLE.replace("alpha: straddle $0.04", "alpha: posts $0.04");
    expect(parse(dead).actions.find((a) => a.type === "straddle")?.verb).toBeUndefined();
    expect(roundTrip(dead)).toBe(dead);
  });

  it("does not let a bare amount masquerade as a post", () => {
    const junk = BARE_STRADDLE.replace("alpha: straddle $0.04", "alpha: 0.04");
    const hand = parse(junk);
    expect(hand.actions.some((a) => a.type === "straddle" || a.type === "post")).toBe(false);
    expect(hand.meta.warnings.map((w) => w.code)).toContain("unknown-line");
  });
});

describe("the showdown token", () => {
  it("echoes the spaced spelling some builds emit", () => {
    const spaced = GROUPED.replace("*** SHOWDOWN ***", "*** SHOW DOWN ***");
    expect(roundTrip(spaced)).toContain("*** SHOW DOWN ***");
    expect(roundTrip(GROUPED)).toContain("*** SHOWDOWN ***");
  });
});

const RESORTED_BOARD = `Poker Hand #TM2: Hold'em No Limit ($0.25/$0.5) - 2020/08/13 16:29:44
Table 'T' 6-max Seat #1 is the button
Seat 1: alpha ($100 in chips)
Seat 2: bravo ($100 in chips)
bravo: posts small blind $0.25
alpha: posts big blind $0.5
*** HOLE CARDS ***
Dealt to alpha [Ac Kh]
bravo: calls $0.25
alpha: checks
*** FLOP *** [Ad 7d 9d]
bravo: checks
alpha: checks
*** TURN *** [7d 9d Ad] [2s]
bravo: checks
alpha: checks
*** RIVER *** [7d 9d Ad 2s] [4h]
bravo: checks
alpha: checks
*** SHOWDOWN ***
alpha: shows [Ac Kh] (a pair of Aces)
bravo: mucks hand
alpha collected $1 from pot
*** SUMMARY ***
Total pot $1 | Rake $0
Board [7d 9d Ad 2s 4h]
Seat 1: alpha (big blind) showed [Ac Kh] and won ($1) with a pair of Aces
Seat 2: bravo (small blind) mucked`;

describe("a board the room restates in a different order", () => {
  it("keeps the deal order on the flop and the restated order after it", () => {
    // Real GG: `*** FLOP *** [Ad 7d 9d]` then `*** TURN *** [7d 9d Ad] [2s]`.
    // Two stored orders reproduce both - `flop` holds the deal order and
    // `summaryCards` holds the order the room restated.
    const hand = parse(RESORTED_BOARD);
    expect(hand.board.runouts[0].flop).toEqual(["Ad", "7d", "9d"]);
    expect(hand.board.runouts[0].summaryCards).toEqual(["7d", "9d", "Ad", "2s", "4h"]);
    expect(roundTrip(RESORTED_BOARD)).toBe(RESORTED_BOARD);
  });

  it("does not reorder when the room is self-consistent", () => {
    const tidy = RESORTED_BOARD.replace(/\[7d 9d Ad/g, "[Ad 7d 9d").replace(
      "Board [Ad 7d 9d 2s 4h]",
      "Board [Ad 7d 9d 2s 4h]",
    );
    expect(roundTrip(tidy)).toBe(tidy);
  });
});
