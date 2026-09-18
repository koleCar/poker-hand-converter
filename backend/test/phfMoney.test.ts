import { describe, expect, it } from "vitest";

import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  CHIPS,
  EUR,
  JPY,
  USD,
  cashUnit,
  formatAmount,
  parseAmount,
  parseBuyInToken,
  totalBuyIn,
  unitForCode,
  unitForSymbol,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

describe("currency units", () => {
  it("resolves the common three-letter codes", () => {
    expect(unitForCode("USD")).toBe(USD);
    expect(unitForCode("eur")).toBe(EUR);
    expect(unitForCode("CAD").code).toBe("CAD");
    expect(unitForCode("BRL").symbol).toBe("R$");
  });

  it("treats an unknown code as cash, not as chips", () => {
    // Falling back to CHIPS would silently multiply every amount by 100.
    const unit = unitForCode("XYZ");
    expect(unit.kind).toBe("cash");
    expect(unit.minorUnits).toBe(100);
    expect(unit.code).toBe("XYZ");
  });

  it("knows the yen has no subunit", () => {
    expect(JPY.minorUnits).toBe(1);
    expect(parseAmount("1500", JPY)).toBe(1500);
    expect(formatAmount(1500, JPY)).toBe("¥1500");
  });

  it("maps symbols, and leaves an unknown one as chips", () => {
    expect(unitForSymbol("€")).toBe(EUR);
    expect(unitForSymbol("$")).toBe(USD);
    expect(unitForSymbol("")).toBe(CHIPS);
    expect(unitForSymbol("???")).toBe(CHIPS);
  });

  it("builds a unit for a currency it has never heard of", () => {
    const unit = cashUnit("HUF", "Ft");
    expect(parseAmount("12.34", unit)).toBe(1234);
    expect(formatAmount(1234, unit, "fixed2")).toBe("Ft12.34");
  });
});

describe("parseBuyInToken", () => {
  it("splits a knockout buy-in into prize pool, bounty and fee", () => {
    // The shape that used to be collapsed to buy-in 9.00 / fee 1.00.
    expect(parseBuyInToken("$4.50+$4.50+$1", USD)).toEqual({
      buyIn: 450,
      bounty: 450,
      fee: 100,
    });
  });

  it("reads a plain buy-in and fee", () => {
    expect(parseBuyInToken("$15+$1.50", USD)).toEqual({ buyIn: 1500, bounty: 0, fee: 150 });
    expect(parseBuyInToken("$100+$9", USD)).toEqual({ buyIn: 10000, bounty: 0, fee: 900 });
  });

  it("reads a single figure and a freeroll", () => {
    expect(parseBuyInToken("$10", USD)).toEqual({ buyIn: 1000, bounty: 0, fee: 0 });
    expect(parseBuyInToken("Freeroll", USD)).toEqual({ buyIn: 0, bounty: 0, fee: 0 });
  });

  it("adds up an unfamiliar four-part token rather than inventing a meaning", () => {
    expect(parseBuyInToken("$1+$2+$3+$1", USD)).toEqual({ buyIn: 600, bounty: 0, fee: 100 });
  });

  it("totals what actually left the account", () => {
    const tournament = {
      id: "1",
      name: null,
      buyIn: 450,
      bounty: 450,
      fee: 100,
      buyInUnit: USD,
      levelLabel: null,
      levelNumber: null,
      levelSmallBlind: 0,
      levelBigBlind: 0,
      levelAnte: 0,
      bounties: [],
    };
    expect(totalBuyIn(tournament)).toBe(1000);
    // A parser written before `bounty` existed still totals correctly.
    expect(totalBuyIn({ ...tournament, bounty: undefined })).toBe(550);
  });
});

const PKO = `Poker Hand #PKO1: Tournament (Bounty Builder)#123456, $4.50+$4.50+$1 Hold'em No Limit - Level V (100/200) - 2026/02/10 17:01:27
Table '123456 3' 6-max Seat #2 is the button
Seat 1: Hero (5000 in chips)
Seat 2: Villain (5000 in chips)
Hero: posts small blind 100
Villain: posts big blind 200
*** HOLE CARDS ***
Dealt to Hero [As Kd]
Hero: raises 400 to 600
Villain: folds
Uncalled bet (400) returned to Hero
*** SHOWDOWN ***
Hero collected 400 from pot
*** SUMMARY ***
Total pot 400 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0
Seat 1: Hero (button) (small blind) collected (400)
Seat 2: Villain (big blind) folded before Flop`;

describe("knockout tournaments", () => {
  it("keeps the bounty portion instead of folding it into the buy-in", () => {
    const hand = parse(PKO);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.tournament).toMatchObject({
      id: "123456",
      name: "Bounty Builder",
      buyIn: 450,
      bounty: 450,
      fee: 100,
    });
    expect(totalBuyIn(hand.tournament!)).toBe(1000);
    // The buy-in is real money even though the stacks are chips.
    expect(hand.tournament?.buyInUnit.code).toBe("USD");
    expect(hand.game.unit.kind).toBe("chips");
  });

  it("round-trips the three-part buy-in through standard text", () => {
    const hand = parse(PKO);
    expect(toStandardText(hand)).toBe(PKO);
    expect(toStandardText(hand)).toContain("$4.50+$4.50+$1 Hold'em No Limit");
  });

  it("still prints a two-part buy-in when there is no bounty", () => {
    const plain = PKO.replace("$4.50+$4.50+$1", "$15+$1.50");
    const hand = parse(plain);
    expect(hand.tournament?.bounty).toBe(0);
    expect(toStandardText(hand)).toBe(plain);
  });

  it("resolves heads-up positions in a tournament too", () => {
    // The button posts the small blind here as well.
    const hand = parse(PKO);
    expect(hand.players.find((p) => p.seat === 1)?.position).toBe("SB");
    expect(hand.players.find((p) => p.seat === 2)?.position).toBe("BB");
  });
});
