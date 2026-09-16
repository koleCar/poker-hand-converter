import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handClass, parseHandClassQuery, resolveHeroQuery } from "../../frontend/src/lib/cards";
import { convertCashWeplayFile } from "../../frontend/src/lib/converter";
import { parseHand, splitHands } from "../../frontend/src/lib/handParser";
import { buildReplay } from "../../frontend/src/lib/replay";

const GG_DIR = join(import.meta.dirname, "../../gg-hh");

function allGgHands(): string[] {
  const files = readdirSync(GG_DIR).filter((name) => name.endsWith(".txt"));
  return files.flatMap((name) => splitHands(readFileSync(join(GG_DIR, name), "utf8")));
}

const SIMPLE_HAND = `Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
Table 'NLHPurple70' 6-max Seat #1 is the button
Seat 1: 8c668f2d ($81.22 in chips)
Seat 2: da2a0a00 ($11.75 in chips)
Seat 3: 41ff0a42 ($50.99 in chips)
Seat 4: Hero ($82.8 in chips)
Seat 5: a28e4f77 ($34.98 in chips)
Seat 6: fb779d10 ($11.68 in chips)
da2a0a00: posts small blind $0.25
41ff0a42: posts big blind $0.5
*** HOLE CARDS ***
Dealt to Hero [5s 8c]
Hero: folds
a28e4f77: folds
fb779d10: raises $0.5 to $1
8c668f2d: folds
da2a0a00: calls $0.75
41ff0a42: calls $0.5
*** FLOP *** [Tc 4h Ad]
da2a0a00: checks
41ff0a42: checks
fb779d10: bets $1.5
da2a0a00: folds
41ff0a42: folds
Uncalled bet ($1.5) returned to fb779d10
*** SHOWDOWN ***
fb779d10 collected $2.85 from pot
*** SUMMARY ***
Total pot $3 | Rake $0.15 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0
Board [Tc 4h Ad]
Seat 6: fb779d10 won ($2.85)`;

describe("parseHand", () => {
  it("reads the header, seats and board", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    expect(hand).not.toBeNull();
    expect(hand.handId).toBe("HD2735958902");
    expect(hand.smallBlind).toBe(0.25);
    expect(hand.bigBlind).toBe(0.5);
    expect(hand.tableName).toBe("NLHPurple70");
    expect(hand.maxSeats).toBe(6);
    expect(hand.buttonSeat).toBe(1);
    expect(hand.seats).toHaveLength(6);
    expect(hand.board).toEqual(["Tc", "4h", "Ad"]);
    expect(hand.heroName).toBe("Hero");
    expect(hand.seats.find((seat) => seat.isHero)?.cards).toEqual(["5s", "8c"]);
    expect(hand.playedAt).toBe("2026-02-17T05:56:01.000Z");
  });

  it("nets the uncalled bet out of the raiser's investment", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    // 1 preflop + 1.5 bet - 1.5 returned = 1
    expect(hand.invested["fb779d10"]).toBe(1);
    expect(hand.invested["da2a0a00"]).toBe(1);
    expect(hand.invested["41ff0a42"]).toBe(1);
    expect(hand.winners).toEqual([{ player: "fb779d10", amount: 2.85 }]);
  });

  it("computes hero profit as collected minus invested", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    expect(hand.heroProfit).toBe(0);
  });

  it("does not count a fold-out as a showdown", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    expect(hand.wentToShowdown).toBe(false);
    expect(hand.streetReached).toBe("flop");
  });

  it("returns null for text that is not a hand history", () => {
    expect(parseHand("hello world")).toBeNull();
  });
});

describe("real GG fixtures", () => {
  const hands = allGgHands();

  it("finds hands in the sample directory", () => {
    expect(hands.length).toBeGreaterThan(50);
  });

  it("parses every sample hand without unknown lines", () => {
    const failures: string[] = [];
    const unknown: string[] = [];
    for (const chunk of hands) {
      const hand = parseHand(chunk);
      if (!hand) {
        failures.push(chunk.split("\n")[0]);
        continue;
      }
      unknown.push(...hand.warnings);
    }
    expect(failures).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("keeps the pot consistent with the summary line", () => {
    const mismatches: string[] = [];
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      const invested = Object.values(hand.invested).reduce((sum, value) => sum + value, 0);
      if (Math.abs(invested - hand.totalPot) > 0.011) {
        mismatches.push(`${hand.handId}: invested ${invested} vs pot ${hand.totalPot}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("never lets a stack go negative during replay", () => {
    const problems: string[] = [];
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      for (const frame of buildReplay(hand)) {
        for (const seat of frame.seats) {
          if (seat.stack < -0.005) {
            problems.push(`${hand.handId} ${seat.name} ${seat.stack}`);
          }
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("awards the whole pot in the final replay frame", () => {
    const problems: string[] = [];
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      if (hand.winners.length === 0) {
        continue;
      }
      const frames = buildReplay(hand);
      const final = frames[frames.length - 1];
      expect(final.kind).toBe("award");
      if (final.pot !== 0) {
        problems.push(`${hand.handId} leftover pot ${final.pot}`);
      }
      const totalWon = final.seats.reduce((sum, seat) => sum + seat.winAmount, 0);
      const expected = hand.winners.reduce((sum, winner) => sum + winner.amount, 0);
      if (Math.abs(totalWon - expected) > 0.011) {
        problems.push(`${hand.handId} awarded ${totalWon} vs ${expected}`);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("reveals the full board by the last frame", () => {
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      const frames = buildReplay(hand);
      expect(frames[frames.length - 1].board).toEqual(hand.board);
    }
  });
});

describe("weplay -> gg -> replay pipeline", () => {
  const WEPLAY_DIR = join(import.meta.dirname, "../../weplay-hh/h.kolaric992@gmail.com");

  it("parses every hand the converter emits from the real WePlay files", () => {
    const files = readdirSync(WEPLAY_DIR).filter((name) => name.endsWith(".txt"));
    expect(files.length).toBeGreaterThan(0);

    let totalHands = 0;
    const failures: string[] = [];
    const unknown: string[] = [];

    for (const name of files) {
      const converted = convertCashWeplayFile(name, readFileSync(join(WEPLAY_DIR, name), "utf8"));
      if (converted.status !== "converted") {
        continue;
      }
      for (const chunk of splitHands(converted.outputText)) {
        const hand = parseHand(chunk);
        if (!hand) {
          failures.push(chunk.split("\n")[0]);
          continue;
        }
        totalHands += 1;
        unknown.push(...hand.warnings);
        // The replay must not throw and must end on an award frame.
        const frames = buildReplay(hand);
        expect(frames[frames.length - 1].kind).toBe("award");
      }
    }

    expect(totalHands).toBeGreaterThan(50);
    expect(failures).toEqual([]);
    expect([...new Set(unknown)]).toEqual([]);
  });
});

describe("card helpers", () => {
  it("builds canonical hand classes", () => {
    expect(handClass(["Ah", "Kh"])).toBe("AKs");
    expect(handClass(["Kd", "Ac"])).toBe("AKo");
    expect(handClass(["Ts", "Td"])).toBe("TT");
    expect(handClass(["Ts"])).toBeNull();
  });

  it("reads a hand class before looking for card codes", () => {
    // "AKs" contains the substring "Ks"; the class reading must win.
    expect(resolveHeroQuery("AKs")).toEqual({ kind: "class", values: ["AKs"] });
    expect(resolveHeroQuery("TT")).toEqual({ kind: "class", values: ["TT"] });
    expect(resolveHeroQuery("AK")).toEqual({ kind: "class", values: ["AKs", "AKo"] });
    expect(resolveHeroQuery("AhKs")).toEqual({ kind: "cards", values: ["Ah", "Ks"] });
    expect(resolveHeroQuery("Ks")).toEqual({ kind: "cards", values: ["Ks"] });
    expect(resolveHeroQuery("")).toEqual({ kind: "none" });
    expect(resolveHeroQuery("nonsense")).toEqual({ kind: "none" });
  });

  it("normalises typed hand class queries", () => {
    expect(parseHandClassQuery("aks")).toEqual(["AKs"]);
    expect(parseHandClassQuery("ka")).toEqual(["AKs", "AKo"]);
    expect(parseHandClassQuery("tt")).toEqual(["TT"]);
    expect(parseHandClassQuery("zz")).toBeNull();
  });
});
