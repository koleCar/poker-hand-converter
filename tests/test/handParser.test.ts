import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handClass, parseHeroHand } from "../../web/src/lib/cards";
import { convertCashWeplayFile } from "../../web/src/lib/converter";
import { parseHand, splitHands } from "../../web/src/lib/phf/index.js";
import type { PhfHand } from "../../web/src/lib/phf/types.js";
import {
  heroOf,
  houseIntoPot,
  primaryBoard,
  toDisplayNumber,
} from "../../web/src/lib/phf/types.js";
import { buildReplay } from "../../web/src/lib/replay";

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

/** Total a player put in, net of uncalled returns, in minor units. */
function contributed(hand: PhfHand, player: string): number {
  return hand.results.players.find((entry) => entry.player === player)?.contributed ?? 0;
}

describe("parseHand", () => {
  it("reads the header, seats and board", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    expect(hand).not.toBeNull();
    expect(hand.meta.handId).toBe("HD2735958902");
    // Minor units throughout: 25 cents and 50 cents, never 0.25 and 0.5.
    expect(hand.game.smallBlind).toBe(25);
    expect(hand.game.bigBlind).toBe(50);
    expect(hand.game.unit.code).toBe("USD");
    expect(hand.table.name).toBe("NLHPurple70");
    expect(hand.table.maxSeats).toBe(6);
    expect(hand.table.buttonSeat).toBe(1);
    expect(hand.players).toHaveLength(6);
    expect(primaryBoard(hand)).toEqual(["Tc", "4h", "Ad"]);
    expect(heroOf(hand)?.name).toBe("Hero");
    expect(heroOf(hand)?.holeCards).toEqual(["5s", "8c"]);
    expect(hand.playedAt).toBe("2026-02-17T05:56:01.000Z");
  });

  it("nets the uncalled bet out of the raiser's investment", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    // $1 preflop + $1.50 bet - $1.50 returned = $1, exactly, in cents.
    expect(contributed(hand, "fb779d10")).toBe(100);
    expect(contributed(hand, "da2a0a00")).toBe(100);
    expect(contributed(hand, "41ff0a42")).toBe(100);
    expect(hand.results.winners).toEqual([
      { player: "fb779d10", seat: 6, amount: 285, runoutIndex: 0 },
    ]);
  });

  it("computes hero profit as collected minus invested", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    expect(hand.results.heroNet).toBe(0);
  });

  it("does not count a fold-out as a showdown", () => {
    const hand = parseHand(SIMPLE_HAND)!;
    expect(hand.results.wentToShowdown).toBe(false);
    expect(hand.results.streetReached).toBe("flop");
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
      unknown.push(...hand.meta.warnings.map((warning) => warning.code));
    }
    expect(failures).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("keeps the pot consistent with the summary line", () => {
    const mismatches: string[] = [];
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      // Integers, so this is an exact equality rather than a float tolerance.
      const invested = hand.results.players.reduce((sum, entry) => sum + entry.contributed, 0);
      if (invested + houseIntoPot(hand) !== hand.results.totalPot) {
        mismatches.push(
          `${hand.meta.handId}: invested ${invested} vs pot ${hand.results.totalPot}`,
        );
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
            problems.push(`${hand.meta.handId} ${seat.name} ${seat.stack}`);
          }
        }
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("awards the whole pot across the replay's award frames", () => {
    const problems: string[] = [];
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      if (hand.results.winners.length === 0) {
        continue;
      }
      const frames = buildReplay(hand);
      const final = frames[frames.length - 1];
      expect(final.kind).toBe("award");
      if (final.pot !== 0) {
        problems.push(`${hand.meta.handId} leftover pot ${final.pot}`);
      }
      // Side pots are paid one frame each, so the seats' running totals only
      // add up once the last award frame has landed.
      const totalWon = final.seats.reduce((sum, seat) => sum + seat.winAmount, 0);
      const expected = hand.results.winners.reduce(
        (sum, winner) => sum + toDisplayNumber(winner.amount, hand.game.unit),
        0,
      );
      if (Math.abs(totalWon - expected) > 0.011) {
        problems.push(`${hand.meta.handId} awarded ${totalWon} vs ${expected}`);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("reveals the full board by the last frame", () => {
    for (const chunk of hands) {
      const hand = parseHand(chunk)!;
      const frames = buildReplay(hand);
      expect(frames[frames.length - 1].board).toEqual(primaryBoard(hand));
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
        unknown.push(...hand.meta.warnings.map((warning) => warning.code));
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

  it("reads the hero's hand search: classes, shortcuts and ranges", () => {
    const classes = (raw: string) => parseHeroHand(raw)?.classes;
    // "AKs" contains the substring "Ks"; the class reading must win.
    expect(parseHeroHand("AKs")).toEqual({ classes: ["AKs"], cards: [] });
    expect(classes("AA")).toEqual(["AA"]);
    expect(classes("tt")).toEqual(["TT"]);
    expect(classes("ka")).toEqual(["AKs", "AKo"]);
    expect(classes("AKss")).toEqual(["AKs"]);
    expect(classes("AKoo")).toEqual(["AKo"]);
    expect(classes("aKo")).toEqual(["AKo"]);
    expect(classes("TT+")).toEqual(["AA", "KK", "QQ", "JJ", "TT"]);
    expect(classes("ATs+")).toEqual(["AKs", "AQs", "AJs", "ATs"]);
    expect(classes("KTo+")).toEqual(["KQo", "KJo", "KTo"]);
    expect(classes("22-44")).toEqual(["44", "33", "22"]);
    expect(classes("44 - 22")).toEqual(["44", "33", "22"]);
    expect(classes("A2s-A4s")).toEqual(["A4s", "A3s", "A2s"]);
    expect(classes("A5-A4")).toEqual(["A5s", "A4s", "A5o", "A4o"]);
    expect(classes("Ax")).toHaveLength(25);
    expect(classes("Axs")).toHaveLength(12);
    expect(classes("Kxo")).toContain("AKo");
    expect(classes("AA, KK AKs")).toEqual(["AA", "AKs", "KK"]);
  });

  it("reads cards in the hero's hand search: all must be held", () => {
    expect(parseHeroHand("Ad")).toEqual({ classes: null, cards: ["Ad"] });
    expect(parseHeroHand("AdAs")).toEqual({ classes: null, cards: ["Ad", "As"] });
    expect(parseHeroHand("ad ks")).toEqual({ classes: null, cards: ["Ad", "Ks"] });
    expect(parseHeroHand("AhKs")).toEqual({ classes: null, cards: ["Ah", "Ks"] });
    expect(parseHeroHand("AdKx")).toEqual({ classes: ["AKs", "AKo"], cards: ["Ad"] });
    expect(parseHeroHand("AdAx")).toEqual({ classes: ["AA"], cards: ["Ad"] });
    // A card and a class: that card, in one of the classes.
    expect(parseHeroHand("Ad, AA")).toEqual({ classes: ["AA"], cards: ["Ad"] });
    expect(parseHeroHand("Ad Kx")?.cards).toEqual(["Ad"]);
    expect(parseHeroHand("Ad Kx")?.classes).toHaveLength(25);
    // Omaha: four suited cards.
    expect(parseHeroHand("AsKsQhJh")?.cards).toEqual(["As", "Ks", "Qh", "Jh"]);
  });

  it("reads nothing as nothing and junk as no hand", () => {
    expect(parseHeroHand("")).toEqual({ classes: null, cards: [] });
    expect(parseHeroHand("   ")).toEqual({ classes: null, cards: [] });
    expect(parseHeroHand("nonsense")).toBeNull();
    expect(parseHeroHand("zz")).toBeNull();
    expect(parseHeroHand("AAs")).toBeNull();
    expect(parseHeroHand("A2s-K5s")).toBeNull();
    expect(parseHeroHand("AxKxQx")).toBeNull();
    expect(parseHeroHand("AA, junk")).toBeNull();
  });
});
