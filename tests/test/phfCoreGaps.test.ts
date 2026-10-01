import { describe, expect, it } from "vitest";

import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  CHIPS,
  EUR,
  FRACTIONAL_CHIPS,
  USD,
  chipsUnitFor,
  houseIntoPot,
  parseAmount,
  parseAmountStrict,
  seatOutOfPot,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

/* ------------------------------------------------------- strict amounts --- */

describe("parseAmountStrict", () => {
  it("reads the European shape the permissive reader gets 100x wrong", () => {
    // The landmine three parser agents each guarded against locally before this
    // existed: `parseAmount` strips every non-digit, so the comma vanishes and
    // 1234.50 euros becomes 12,345.00. The hand then balances against itself.
    expect(parseAmountStrict("1 234,50 €", EUR)).toEqual({ ok: true, amount: 123450 });
    expect(parseAmount("1 234,50 €", EUR)).toBe(12345000);
  });

  it("reads grouped thousands as thousands, in either locale", () => {
    expect(parseAmountStrict("$1,050", USD)).toEqual({ ok: true, amount: 105000 });
    expect(parseAmountStrict("1.050", USD)).toEqual({ ok: true, amount: 105000 });
    expect(parseAmountStrict("1.234.567", USD)).toEqual({ ok: true, amount: 123456700 });
    expect(parseAmountStrict("1,234.50", USD)).toEqual({ ok: true, amount: 123450 });
    expect(parseAmountStrict("1.234,50", EUR)).toEqual({ ok: true, amount: 123450 });
  });

  it("keeps a leading zero decimal a decimal, not a group", () => {
    // `0.025` has three digits after the separator like `1,050` does, but `0`
    // is not a valid leading group, so it stays a decimal and is then refused.
    expect(parseAmountStrict("0.025", USD)).toEqual({
      ok: false,
      problem: "too-precise",
      text: "0.025",
    });
    expect(parseAmountStrict("0.50", USD)).toEqual({ ok: true, amount: 50 });
    expect(parseAmountStrict("0.5", USD)).toEqual({ ok: true, amount: 50 });
  });

  it("refuses precision the unit cannot hold rather than rounding it", () => {
    expect(parseAmountStrict("2642.50", CHIPS).ok).toBe(false);
    expect(parseAmountStrict("2642.50", FRACTIONAL_CHIPS)).toEqual({ ok: true, amount: 264250 });
    expect(parseAmountStrict("2260", CHIPS)).toEqual({ ok: true, amount: 2260 });
  });

  it("refuses junk and signs negatives", () => {
    expect(parseAmountStrict("abc", USD).ok).toBe(false);
    expect(parseAmountStrict("", USD).ok).toBe(false);
    expect(parseAmountStrict("-0.50", USD)).toEqual({ ok: true, amount: -50 });
  });
});

describe("chipsUnitFor", () => {
  it("picks hundredths only when the source actually deals fractional chips", () => {
    expect(chipsUnitFor("Seat 1: a (2642.50 in chips)")).toBe(FRACTIONAL_CHIPS);
    expect(chipsUnitFor("Seat 1: a (21929 in chips)")).toBe(CHIPS);
  });
});

/* --------------------------------------------------- non-pot chip moves --- */

const STP = `Poker Hand #STP1: Hold'em No Limit ($0.05/$0.10) - 2019/06/01 10:00:00
Table 'RIO' 6-max Seat #1 is the button
Seat 1: alpha ($10 in chips)
Seat 2: bravo ($10 in chips)
bravo: posts small blind $0.05
alpha: posts big blind $0.10
*** HOLE CARDS ***
STP added: $0.50
Dealt to alpha [Ac Kh]
bravo: folds
Uncalled bet ($0.05) returned to alpha
*** SHOWDOWN ***
alpha: doesn't show hand
alpha collected $0.60 from pot
*** SUMMARY ***
Total pot $0.60 | Rake $0
Seat 1: alpha (big blind) collected ($0.60)
Seat 2: bravo (small blind) folded before Flop`;

describe("house chips into the pot", () => {
  it("balances a pot that is bigger than what the players put in", () => {
    // Players contribute $0.10; the house adds $0.50; the winner takes $0.60.
    // Without a home for the drop this is a `chip-mismatch` and the hand is
    // refused - which is what both GG and Run It Once parsers had to do.
    const hand = parse(STP);
    expect(validateHand(hand).ok).toBe(true);
    expect(houseIntoPot(hand)).toBe(50);
    expect(hand.chipMovements).toEqual([
      {
        kind: "splash-the-pot",
        fromSeat: null,
        fromPlayer: null,
        toPot: true,
        amount: 50,
        raw: "STP added: $0.50",
        anchor: "after-hole-cards",
      },
    ]);
  });

  it("corrupts nobody's net", () => {
    const hand = parse(STP);
    const alpha = hand.results.players.find((p) => p.player === "alpha")!;
    // Posted the big blind and had the uncalled 5 returned, so 5 of their own
    // went in. The promo money is not part of anyone's investment.
    expect(alpha.contributed).toBe(5);
    expect(alpha.net).toBe(55);
  });

  it("starts the replay with the promo chips already in the middle", () => {
    const frames = buildReplay(parse(STP));
    expect(frames[0].pot).toBe(0.5);
    const final = frames[frames.length - 1];
    expect(final.pot).toBe(0);
    expect(final.seats.reduce((sum, seat) => sum + seat.winAmount, 0)).toBeCloseTo(0.6, 5);
  });

  it("round-trips the drop line at the anchor the room printed it", () => {
    expect(toStandardText(parse(STP))).toBe(STP);
    // GG prints it before the blinds instead, and that has to survive too.
    const gg = STP.replace("*** HOLE CARDS ***\nSTP added: $0.50\n", "*** HOLE CARDS ***\n")
      .replace("Seat 2: bravo ($10 in chips)\n", "Seat 2: bravo ($10 in chips)\nCash Drop to Pot : total $0.5\n");
    const hand = parse(gg);
    expect(hand.chipMovements?.[0]).toMatchObject({
      kind: "cash-drop",
      anchor: "before-postings",
      amount: 50,
    });
    expect(toStandardText(hand)).toBe(gg);
  });
});

describe("chips leaving a stack without reaching the pot", () => {
  it("takes a jackpot drop off the stack and leaves the pot alone", () => {
    // MicroGaming's `BadBeatContribution`. It cannot be a fee, because fees are
    // taken *from* the pot and counting it there breaks the payout check.
    const hand = parse(STP);
    hand.chipMovements = [
      {
        kind: "bad-beat-drop",
        fromSeat: 2,
        fromPlayer: "bravo",
        toPot: false,
        amount: 2,
        raw: null,
        anchor: "before-postings",
      },
    ];
    expect(hand.results.totalPot).toBe(60);
    // The pot no longer balances, because the promo money is gone from the
    // fixture; what matters here is that the drop did not change the pot.
    expect(houseIntoPot(hand)).toBe(0);
    expect(seatOutOfPot(hand, 2)).toBe(2);

    const first = buildReplay(hand)[0];
    const bravo = first.seats.find((seat) => seat.name === "bravo")!;
    expect(bravo.stack).toBeCloseTo(9.98, 5);
  });

  it("refuses a drop charged to an empty seat", () => {
    const hand = parse(STP);
    hand.chipMovements = [
      {
        kind: "bad-beat-drop",
        fromSeat: 9,
        fromPlayer: "ghost",
        toPot: false,
        amount: 2,
        raw: null,
        anchor: "before-postings",
      },
    ];
    expect(validateHand(hand).errors.map((p) => p.code)).toContain("unseated-chip-movement");
  });
});

/* ------------------------------------------------------ header coverage --- */

const NO_LEVEL = `Poker Hand #UNI1: Tournament (Banzai Bounty)#85614762, €0.93+€0.07 Hold'em No Limit - (25/50) - 2026/06/05 21:59:56
Table 'T' 6-max Seat #1 is the button
Seat 1: alpha (1000 in chips)
Seat 2: bravo (1000 in chips)
bravo: posts small blind 25
alpha: posts big blind 50
*** HOLE CARDS ***
Dealt to alpha [Ac Kh]
bravo: folds
Uncalled bet (25) returned to alpha
*** SHOWDOWN ***
alpha: doesn't show hand
alpha collected 50 from pot
*** SUMMARY ***
Total pot 50 | Rake 0
Seat 1: alpha (big blind) collected (50)
Seat 2: bravo (small blind) folded before Flop`;

describe("a tournament with no level", () => {
  it("round-trips without inventing Level I", () => {
    // Unibet and Chico state blinds but never a level. Writing `Level I` for a
    // hand that has none reads back as level 1, which is fabricated data.
    const hand = parse(NO_LEVEL);
    expect(hand.tournament?.levelLabel).toBeNull();
    expect(hand.tournament?.levelNumber).toBeNull();
    expect(hand.tournament?.levelSmallBlind).toBe(25);
    expect(toStandardText(hand)).toBe(NO_LEVEL);
    expect(toStandardText(hand)).not.toContain("Level");
  });
});

describe("a tournament name containing the game vocabulary", () => {
  it("matches the game label from the end, not the first keyword", () => {
    // GG: `WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD
    // Hold'em No Limit` - "Hold'em" twice and two money amounts. Splitting on
    // the first match put most of the name into the label and lost the buy-in.
    const wsop = NO_LEVEL.replace(
      "Tournament (Banzai Bounty)#85614762, €0.93+€0.07 Hold'em No Limit - (25/50)",
      "Tournament #25313426, WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10 (25/50)",
    );
    const hand = parse(wsop);
    expect(hand.game.label).toBe("Hold'em No Limit");
    expect(hand.tournament?.name).toBe(
      "WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD",
    );
    expect(toStandardText(hand)).toBe(wsop);
  });

  it("still reads labels that do not end in a limit phrase", () => {
    const split = NO_LEVEL.replace(
      "€0.93+€0.07 Hold'em No Limit",
      "€0.93+€0.07 Hold'em Pot Limit Pre-Flop, No Limit Post-Flop",
    );
    expect(parse(split).game.label).toBe("Hold'em Pot Limit Pre-Flop, No Limit Post-Flop");
  });
});
