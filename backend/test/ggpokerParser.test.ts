/**
 * GGPoker parser, driven over the whole reference corpus.
 *
 * The ground truth is `gg-hh/` - 431 real hands from the GG client - plus
 * `fixtures/samples/ggpoker/` files 01-32, which are real and byte-verified.
 * Because GG's export is the same grammar this project's standard text was
 * modelled on, the strongest check available is *parity*: on the cash dialect
 * this parser and `parseStandardHand` must produce the same PHF for the same
 * bytes, and `toStandardText` must give the source text back byte for byte.
 *
 * There are no skin fixtures. The skins were investigated and the answer is
 * that only GGPoker itself can be vouched for - see the header of
 * `parsers/ggpoker.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  convertAny,
  detectSite,
  getParser,
  ggpokerParser,
  pokerstarsParser,
} from "../../frontend/src/lib/parsers/index.js";
import { ParseSkip } from "../../frontend/src/lib/phf/detect.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import { toDisplayNumber, type PhfHand } from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import {
  FOREIGN_SITES,
  ggCorpusFiles,
  ownFixtures,
  sampleFiles,
} from "./support/psggCorpus.js";
import { allInvariants, roundTripsThroughStandardText } from "./support/psggInvariants.js";

const CTX = { sourceFilename: null, options: {} };

/**
 * Fixtures whose provenance does not support asserting on them.
 *
 * `fixtures/samples/ggpoker/` files 01-32 are real and byte-verified. 33-35 are
 * fpdb-3's own *unit-test* fixtures rather than captured exports, and
 * `SOURCES.md` marks them unverified: one puts the `TM` tournament prefix on a
 * plain cash hand, one uses transparently sequential fake anonymisation ids
 * (`1a2b3c4d`, `2b3c4d5e`, ...) and a `X: collected` colon nothing else in the
 * corpus writes, and one carries a `*** PREFLOP ***` marker seen nowhere else.
 * Hardening a grammar against a hand-written test fixture is how a parser
 * acquires rules the real site never emits, so they are excluded from the
 * assertions and exercised only as "must not crash" input.
 *
 * The numbering has a gap at 20: that fixture was empty in the fpdb-3
 * repository itself, so it was deleted rather than carried as a stub.
 */
const UNVERIFIED = /^(?:33|34|35)-/;

/** `gg-hh/` plus the verified GGPoker samples. */
const ALL_FILES = [...ggCorpusFiles(), ...sampleFiles("ggpoker"), ...ownFixtures("ggpoker")];
const FILES = ALL_FILES.filter((file) => !UNVERIFIED.test(file.name));

interface Parsed {
  file: string;
  raw: string;
  hand: PhfHand | null;
  skip: ParseSkip | null;
}

const PARSED: Parsed[] = FILES.flatMap((file) =>
  ggpokerParser.splitHands(file.text).map((chunk): Parsed => {
    try {
      return { file: file.name, raw: chunk, hand: ggpokerParser.parseHand(chunk, CTX), skip: null };
    } catch (error) {
      return {
        file: file.name,
        raw: chunk,
        hand: null,
        skip: error instanceof ParseSkip ? error : null,
      };
    }
  }),
);
const HANDS = PARSED.filter((entry) => entry.hand).map((entry) => entry.hand!);

function handById(id: string): PhfHand {
  const hand = HANDS.find((entry) => entry.meta.handId === id);
  if (!hand) {
    throw new Error(`hand ${id} is not in the corpus`);
  }
  return hand;
}

describe("GGPoker detection", () => {
  it.each(FILES.map((file) => [file.relativePath, file] as const))(
    "%s is recognised as GG",
    (_name, file) => {
      expect(ggpokerParser.detect(file.text)).toBeGreaterThanOrEqual(0.86);
    },
  );

  it("never crashes on the unverified fpdb-3 unit-test fixtures", () => {
    // Not asserted on - see `UNVERIFIED` - but they still have to be safe input.
    for (const file of ALL_FILES.filter((entry) => UNVERIFIED.test(entry.name))) {
      expect(() => ggpokerParser.detect(file.text)).not.toThrow();
      for (const chunk of ggpokerParser.splitHands(file.text)) {
        try {
          ggpokerParser.parseHand(chunk, CTX);
        } catch (error) {
          // A refusal is fine; an unhandled crash is not.
          expect(error).toBeInstanceOf(ParseSkip);
        }
      }
    }
  });

  it("yields the plain cash dialect to the standard parser", () => {
    // `parsers/standard.ts` was written against this exact corpus and claims
    // `Poker Hand #` at 0.9. Outranking it here would silently re-route every
    // stored GG hand through a second implementation for no gain, so the plain
    // dialect is deliberately claimed at 0.86.
    for (const file of ggCorpusFiles()) {
      expect(ggpokerParser.detect(file.text)).toBe(0.86);
      expect(detectSite(file.text)[0]?.parser.id).toBe("standard");
    }
  });

  it("outranks the standard parser on GG products it cannot read", () => {
    const rushAndCash = [
      "Poker Hand #RC2600000001: Hold'em No Limit ($0.05/$0.1) - 2026/03/01 10:00:00",
      "Table 'Rush & Cash 40' 6-max Seat #1 is the button",
    ].join("\n");
    expect(ggpokerParser.detect(rushAndCash)).toBe(0.95);
    expect(detectSite(rushAndCash)[0]?.parser.id).toBe("ggpoker");
  });

  it.each(FOREIGN_SITES.map((site) => [site] as const))(
    "does not claim a single file from fixtures/samples/%s",
    (site) => {
      const claimed = sampleFiles(site).filter((file) => ggpokerParser.detect(file.text) > 0);
      expect(claimed.map((file) => file.relativePath)).toEqual([]);
    },
  );

  it("does not claim PokerStars, even when the file looks GG shaped", () => {
    for (const file of sampleFiles("pokerstars")) {
      expect(ggpokerParser.detect(file.text)).toBe(0);
    }
  });

  it("never throws, whatever it is handed", () => {
    for (const text of ["", "hello", " ", "Poker Hand #", "GG"]) {
      expect(() => ggpokerParser.detect(text)).not.toThrow();
    }
  });
});

describe("GGPoker corpus", () => {
  it("has the whole reference corpus to work with", () => {
    expect(HANDS.length).toBeGreaterThanOrEqual(431);
  });

  it("converts every hand, or refuses it with a machine readable reason", () => {
    const crashed = PARSED.filter((entry) => !entry.hand && !entry.skip);
    expect(crashed.map((entry) => entry.file)).toEqual([]);
  });

  it("emits no hand the validator rejects", () => {
    const problems = HANDS.flatMap((hand) => {
      const report = validateHand(hand);
      return report.ok
        ? []
        : [`${hand.meta.handId}: ${report.errors.map((error) => error.code).join(",")}`];
    });
    expect(problems).toEqual([]);
  });

  it("understands every line it is given", () => {
    const problems = HANDS.flatMap((hand) =>
      hand.meta.warnings
        .filter((warning) => warning.code.startsWith("unknown"))
        .map((warning) => `${hand.meta.handId} line ${warning.line}: ${warning.message}`),
    );
    expect(problems).toEqual([]);
  });

  it("holds every invariant on every hand", () => {
    const problems = HANDS.flatMap((hand) => allInvariants(hand));
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("re-serializes every hand byte for byte", () => {
    // GG's text *is* the standard text, so this is an exact equality rather
    // than the semantic comparison the other rooms get. Holdem Manager import
    // is byte sensitive and this is what protects it.
    //
    const problems: string[] = [];
    for (const entry of PARSED) {
      if (!entry.hand) {
        continue;
      }
      if (toStandardText(entry.hand).trim() !== entry.raw.trim()) {
        problems.push(entry.hand.meta.handId);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("keeps the flop in the order GG dealt it, even when GG restates it sorted", () => {
    // Fixture 30 prints the same flop two ways in the same hand:
    //
    //   `*** FLOP *** [Ad 7d 9d]`          <- the order it was dealt
    //   `*** TURN *** [7d 9d Ad] [2s]`     <- restated, re-ordered
    //   `Board [7d 9d Ad 2s 4h]`           <- summary, same re-ordering
    //
    // `PhfRunout.flop` holds the deal order, because that is what actually
    // happened at the table and what the replayer animates. The restatement
    // order is not lost either: it is already captured verbatim in
    // `summaryCards`, which is what lets `toStandardText` reproduce both
    // spellings and keeps the hand above byte-exact.
    const hand = handById("TM316262814");
    expect(hand.board.runouts[0].flop).toEqual(["Ad", "7d", "9d"]);
    expect(hand.board.runouts[0].summaryCards).toEqual(["7d", "9d", "Ad", "2s", "4h"]);
    // Same three cards either way; only the print order ever differed.
    expect([...hand.board.runouts[0].flop!].sort()).toEqual(
      hand.board.runouts[0].summaryCards!.slice(0, 3).sort(),
    );
    expect(allInvariants(hand)).toEqual([]);
  });

  it("agrees with the standard parser on every cash hand", () => {
    // Two independent readers of the same bytes; a disagreement is a bug in one
    // of them and this is the cheapest way to find out which.
    //
    // Cash only, because the two readers are not *meant* to agree on
    // tournaments: `standard`'s header grammar is PokerStars' `Level VII
    // (75/150)` with no tournament name, and GG writes
    // `Daily Special $250 Hold'em No Limit - Level2 (60/120)`. `standard` falls
    // through to its cash branch on those and produces a hand with no
    // tournament block at all - which is precisely the gap this parser exists
    // to close, and is checked directly further down rather than here.
    const project = (hand: PhfHand) =>
      JSON.stringify({
        actions: hand.actions.map((a) => [a.street, a.type, a.amount, a.streetTotal, a.player, a.runoutIndex]),
        players: hand.players.map((p) => [p.seat, p.name, p.startingStack, p.holeCards]),
        pot: hand.results.totalPot,
        fees: hand.results.fees,
        board: hand.board,
      });
    const problems: string[] = [];
    let compared = 0;
    for (const entry of PARSED) {
      if (!entry.hand || entry.hand.tournament) {
        continue;
      }
      compared += 1;
      const standard = parseStandardHand(entry.raw, {
        siteId: "standard",
        siteName: "standard",
        originalFilename: null,
      });
      if (!standard || project(entry.hand) !== project(standard)) {
        problems.push(entry.hand.meta.handId);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(compared).toBeGreaterThan(400);
  });

  it("reads every GG tournament header, including the hardest one in the corpus", () => {
    // The hardest is fixture 30, whose *name* contains the phrase
    // "No Limit Hold'em" and a second money amount:
    //
    //   `Tournament #9364957, WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit - Level10 (1,000/2,000)`
    //
    // Splitting it on the first money token puts most of the name into the game
    // label. Matching the game label from the *end* - it is a closed vocabulary
    // and always sits last - gets both right. The generic reader used to fail
    // this and has since adopted the same approach (`GAME_LABEL_EXACT` in
    // `phf/serialize.ts`), so the two now agree; the assertion below is kept
    // pointing at the header that proved the rule.
    const tournaments = PARSED.filter((entry) => entry.hand?.tournament);
    expect(tournaments.length).toBeGreaterThan(50);
    for (const entry of tournaments) {
      expect(entry.hand!.game.label).toMatch(/Hold'em/);
      expect(entry.hand!.tournament!.id).toMatch(/^\d+$/);
    }

    const wsop = handById("TM316262814");
    expect(wsop.game.label).toBe("Hold'em No Limit");
    expect(wsop.tournament!.name).toBe(
      "WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD",
    );
    const standard = parseStandardHand(
      PARSED.find((entry) => entry.hand?.meta.handId === "TM316262814")!.raw,
      { siteId: "standard", siteName: "standard", originalFilename: null },
    );
    expect(standard!.game.label).toBe(wsop.game.label);
  });

  it("still has to win detection on GG hands, for the variant policy", () => {
    // The two readers now agree on every hand they both accept, so parsing
    // alone is no longer the reason GG uploads route here. The reason is what
    // happens to the hands this parser *refuses*: the generic reader has no
    // variant policy, so on the exact same bytes it emits ShortDeck and Omaha
    // hands that validate cleanly and would be stored as if they were
    // supported. Round one is Hold'em only, and a wrong hand is worse than a
    // refused one, so detection has to keep sending GG text to the parser that
    // says no.
    let bothAccept = 0;
    let weRefuseTheyDont = 0;
    for (const entry of PARSED) {
      const standard = parseStandardHand(entry.raw, {
        siteId: "standard",
        siteName: "standard",
        originalFilename: null,
      });
      if (entry.hand) {
        bothAccept += 1;
        continue;
      }
      if (entry.skip && standard && validateHand(standard).ok) {
        weRefuseTheyDont += 1;
        expect(entry.skip.reason).toBe("unsupported-variant");
        expect(standard.game.variant).not.toBe("holdem");
      }
    }
    expect(bothAccept).toBeGreaterThan(400);
    expect(weRefuseTheyDont).toBeGreaterThan(100);
  });

  it("replays every hand without a negative stack and pays the pot out", () => {
    const problems: string[] = [];
    for (const hand of HANDS) {
      const frames = buildReplay(hand);
      for (const frame of frames) {
        for (const seat of frame.seats) {
          if (seat.stack < -0.005) {
            problems.push(`${hand.meta.handId}: ${seat.name} at ${seat.stack}`);
          }
        }
      }
      if (hand.results.winners.length === 0) {
        continue;
      }
      const final = frames[frames.length - 1];
      if (final.pot !== 0) {
        problems.push(`${hand.meta.handId}: ${final.pot} left in the pot`);
      }
      const awarded = final.seats.reduce((sum, seat) => sum + seat.winAmount, 0);
      const expected = hand.results.winners.reduce(
        (sum, winner) => sum + toDisplayNumber(winner.amount, hand.game.unit),
        0,
      );
      if (Math.abs(awarded - expected) > 0.011) {
        problems.push(`${hand.meta.handId}: awarded ${awarded} of ${expected}`);
      }
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("stamps provenance and keeps the hand key equal to the GG id", () => {
    for (const hand of HANDS) {
      expect(hand.meta.siteId).toBe("ggpoker");
      expect(hand.meta.parserVersion).toBe(ggpokerParser.version);
      // Rows stored before this parser existed keyed on the bare GG id, so a
      // re-upload has to dedupe against them.
      expect(hand.meta.handKey).toBe(hand.meta.handId);
    }
  });
});

describe("GGPoker specifics", () => {
  it("names the observer Hero and leaves every villain anonymous", () => {
    const hand = handById("HD2735913251");
    expect(hand.players.find((player) => player.isHero)?.name).toBe("Hero");
    expect(hand.players.filter((player) => player.isHero)).toHaveLength(1);
    // GG anonymises everybody else to eight hex characters.
    for (const player of hand.players) {
      if (!player.isHero) {
        expect(player.name).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });

  it("keeps a villain's empty deal line apart from their hole cards", () => {
    // GG prints `Dealt to <villain> ` with a trailing space and no cards. That
    // is "dealt in", not "we know the cards", and the summary can still reveal
    // them later; conflating the two breaks the replayer's face-up logic.
    const hand = handById("HD2735913251");
    const villain = hand.players.find((player) => player.name === "d971c0c0")!;
    expect(villain.dealtAnnounced).toBe(true);
    expect(villain.dealtCards).toEqual([]);
    expect(villain.holeCards).toEqual(["3d", "2h"]);
    expect(hand.meta.textStyle.dealtLinesForAllPlayers).toBe(true);
  });

  it("reads a run-it-twice hand as two runouts that share the flop", () => {
    const hand = handById("HD2735913251");
    expect(hand.board.runouts).toHaveLength(2);
    expect(hand.board.runouts[0].flop).toEqual(["3s", "6s", "2d"]);
    // `*** SECOND FLOP ***` was never printed, so the second runout inherits it.
    expect(hand.board.runouts[1].flop).toBeNull();
    expect(hand.board.runouts[1].turn).toBe("5d");
    expect(hand.board.runouts[1].river).toBe("Kh");
    // The SUMMARY only lists the cards that differ; that is faithful output,
    // never data.
    expect(hand.board.runouts[1].summaryCards).toEqual(["5d", "Kh"]);
    expect(hand.meta.textStyle.showdownLabels).toEqual(["FIRST", "SECOND"]);
    expect(hand.meta.textStyle.runItTwiceNote).toBe(true);
    const winners = hand.results.winners;
    expect(winners.map((winner) => winner.runoutIndex)).toEqual([0, 1]);
  });

  it("settles an EV cashout outside the pot", () => {
    const hand = handById("HD2735972142");
    const choose = hand.actions.find((action) => action.type === "cashout-choose")!;
    const pay = hand.actions.find((action) => action.type === "cashout-pay")!;
    expect(choose.amount).toBe(0);
    expect(pay.amount).toBe(0);
    // The events happen on the streets they were printed on, not at showdown.
    expect(choose.street).toBe("turn");
    expect(pay.street).toBe("river");
    // The risk is reported on the seat, and the pot is untouched by it.
    const seat = hand.results.players.find((player) => player.player === "d31522d6")!;
    expect(seat.cashoutRisk).toBe(1900);
    expect(hand.results.totalPot).toBe(8899);
    expect(validateHand(hand).ok).toBe(true);
  });

  it("breaks the fee line out into every column GG reports", () => {
    const hand = handById("HD2735972142");
    expect(hand.results.fees).toEqual({
      rake: 400,
      jackpot: 50,
      bingo: 0,
      fortune: 0,
      tax: 0,
      other: 0,
    });
    // GG deducts the fees from the pot it reports, so the collect is short of it.
    const collected = hand.results.winners.reduce((sum, winner) => sum + winner.amount, 0);
    expect(collected + 450).toBe(hand.results.totalPot);
  });

  it("uses GG's minimal decimal style", () => {
    const hand = handById("HD2735972142");
    expect(hand.meta.textStyle.decimals).toBe("minimal");
  });
});

/**
 * Products `gg-hh/` does not contain.
 *
 * The reference corpus is 6-max NLHE cash only, so the hands below are written
 * from the documented GG grammar rather than harvested. They live in the test
 * file, not in a fixtures directory, so that nobody mistakes them for ground
 * truth.
 */
describe("GGPoker products not covered by the reference corpus", () => {
  // The header is a real one, quoted verbatim from a PokerTracker support
  // thread about GG tournament detection; only the body below it is written.
  // https://www.pokertracker.com/forums/viewtopic.php?p=359068
  const TOURNAMENT = [
    "Poker Hand #TM299841990: Tournament #8205074, Daily Special $55 Hold'em No Limit - Level7 (150/300) - 2020/08/13 16:29:44",
    "Table '5' 9-max Seat #1 is the button",
    "Seat 1: aaaaaaaa (12000 in chips)",
    "Seat 2: bbbbbbbb (9500 in chips)",
    "Seat 3: Hero (30100 in chips)",
    "aaaaaaaa: posts the ante 40",
    "bbbbbbbb: posts the ante 40",
    "Hero: posts the ante 40",
    "bbbbbbbb: posts small blind 150",
    "Hero: posts big blind 300",
    "*** HOLE CARDS ***",
    "Dealt to aaaaaaaa ",
    "Dealt to bbbbbbbb ",
    "Dealt to Hero [Ah Kd]",
    "aaaaaaaa: folds",
    "bbbbbbbb: folds",
    "Uncalled bet (150) returned to Hero",
    "*** SHOWDOWN ***",
    "Hero: doesn't show hand",
    "Hero collected 420 from pot",
    "*** SUMMARY ***",
    "Total pot 420 | Rake 0 | Jackpot 0 | Bingo 0 | Fortune 0 | Tax 0",
    "Seat 1: aaaaaaaa (button) folded before Flop (didn't bet)",
    "Seat 2: bbbbbbbb (small blind) folded before Flop",
    "Seat 3: Hero (big blind) collected (420)",
  ].join("\n");

  it("reads GG's own tournament header, which numbers the level", () => {
    // GG writes `Level7 (150/300)` and, on other builds, `Level3(150/300)`.
    // PokerStars writes `Level VII (150/300)`. The generic reader only knows
    // the roman-numeral-with-a-space form, misses GG's entirely and falls
    // through to its cash branch - which is why this parser has to outrank it
    // on tournaments.
    const hand = ggpokerParser.parseHand(TOURNAMENT, CTX);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.game.format).toBe("tournament");
    expect(hand.game.unit.minorUnits).toBe(1);
    expect(hand.tournament).toMatchObject({
      id: "8205074",
      // GG puts the tournament name between the id and the game label, where
      // PokerStars prints no name at all. The buy-in is part of the printed
      // name and is kept in it verbatim; `buyIn` carries the parsed number.
      name: "Daily Special $55",
      buyIn: 5500,
      levelLabel: "7",
      levelNumber: 7,
      levelSmallBlind: 150,
      levelBigBlind: 300,
    });
    expect(hand.tournament?.buyInUnit.code).toBe("USD");
    expect(hand.game.anteModel).toBe("posted-per-player");
    expect(allInvariants(hand)).toEqual([]);
    expect(ggpokerParser.detect(TOURNAMENT)).toBe(0.95);
    expect(detectSite(TOURNAMENT)[0]?.parser.id).toBe("ggpoker");
  });

  it("reads the level with no space after the word, which GG also emits", () => {
    const squashed = TOURNAMENT.replace("- Level7 (150/300) -", "- Level7(150/300) -");
    const hand = ggpokerParser.parseHand(squashed, CTX);
    expect(hand.tournament?.levelNumber).toBe(7);
    expect(validateHand(hand).ok).toBe(true);
  });

  it("reads a freeroll buy-in as zero rather than as junk", () => {
    const freeroll = TOURNAMENT.replace(
      "Daily Special $55 Hold'em No Limit",
      "Freeroll Hold'em No Limit",
    );
    const hand = ggpokerParser.parseHand(freeroll, CTX);
    expect(hand.tournament?.buyIn).toBe(0);
    expect(hand.game.label).toBe("Hold'em No Limit");
    expect(validateHand(hand).ok).toBe(true);
  });

  it("reads a Rush & Cash hand and claims it over the generic reader", () => {
    const rushAndCash = [
      "Poker Hand #RC2600000001: Hold'em No Limit ($0.05/$0.1) - 2026/03/01 10:00:00",
      "Table 'Rush & Cash 40' 6-max Seat #1 is the button",
      "Seat 1: aaaaaaaa ($10 in chips)",
      "Seat 2: bbbbbbbb ($9.5 in chips)",
      "Seat 3: Hero ($12.34 in chips)",
      "bbbbbbbb: posts small blind $0.05",
      "Hero: posts big blind $0.1",
      "*** HOLE CARDS ***",
      "Dealt to aaaaaaaa ",
      "Dealt to bbbbbbbb ",
      "Dealt to Hero [Ah Kd]",
      "aaaaaaaa: folds",
      "bbbbbbbb: folds",
      "Uncalled bet ($0.05) returned to Hero",
      "*** SHOWDOWN ***",
      "Hero: doesn't show hand",
      "Hero collected $0.1 from pot",
      "*** SUMMARY ***",
      "Total pot $0.1 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0",
      "Seat 1: aaaaaaaa (button) folded before Flop (didn't bet)",
      "Seat 2: bbbbbbbb (small blind) folded before Flop",
      "Seat 3: Hero (big blind) collected ($0.1)",
    ].join("\n");
    const hand = ggpokerParser.parseHand(rushAndCash, CTX);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.game.format).toBe("cash");
    expect(hand.table.name).toBe("Rush & Cash 40");
    expect(detectSite(rushAndCash)[0]?.parser.id).toBe("ggpoker");
    expect(allInvariants(hand)).toEqual([]);
  });

  it("reads a named straddle without treating it as a raise", () => {
    const straddled = [
      "Poker Hand #HD2600000002: Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
      "Table 'NLHPurple1' 6-max Seat #1 is the button",
      "Seat 1: aaaaaaaa ($50 in chips)",
      "Seat 2: bbbbbbbb ($50 in chips)",
      "Seat 3: Hero ($50 in chips)",
      "bbbbbbbb: posts small blind $0.25",
      "Hero: posts big blind $0.5",
      "aaaaaaaa: posts straddle $1",
      "*** HOLE CARDS ***",
      "Dealt to aaaaaaaa ",
      "Dealt to bbbbbbbb ",
      "Dealt to Hero [Ah Kd]",
      "bbbbbbbb: folds",
      "Hero: folds",
      "Uncalled bet ($0.5) returned to aaaaaaaa",
      "*** SHOWDOWN ***",
      "aaaaaaaa: doesn't show hand",
      "aaaaaaaa collected $1.25 from pot",
      "*** SUMMARY ***",
      "Total pot $1.25 | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0",
      "Seat 1: aaaaaaaa (button) collected ($1.25)",
      "Seat 2: bbbbbbbb (small blind) folded before Flop",
      "Seat 3: Hero (big blind) folded before Flop",
    ].join("\n");
    const hand = ggpokerParser.parseHand(straddled, CTX);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.game.straddles).toEqual([
      { seat: 1, player: "aaaaaaaa", amount: 100, order: 1 },
    ]);
    const straddle = hand.actions.find((action) => action.type === "straddle")!;
    expect(straddle.streetTotal).toBe(100);
    expect(straddle.verb).toBe("posts straddle");
    expect(allInvariants(hand)).toEqual([]);
  });
});

/**
 * Line shapes and header shapes found only in the real fpdb corpus (files
 * 11-32), every one of which a parser built against `gg-hh/` alone gets wrong.
 */
describe("GGPoker shapes the reference corpus does not contain", () => {
  const CASH_DROP_HAND = [
      "Poker Hand #RC58843004: Hold'em No Limit ($0.01/$0.02) - 2021/04/12 07:43:21",
      "Table 'RushAndCash328990' 6-max Seat #1 is the button",
      "Seat 1: 9d7f4cb8 ($3.26 in chips)",
      "Seat 2: 8d962552 ($2 in chips)",
      "Cash Drop to Pot : total $0.2",
      "8d962552: posts small blind $0.01",
      "9d7f4cb8: posts big blind $0.02",
      "*** HOLE CARDS ***",
      "Dealt to 9d7f4cb8 ",
      "Dealt to 8d962552 ",
      "8d962552: folds",
      "Uncalled bet ($0.01) returned to 9d7f4cb8",
      "9d7f4cb8 collected $0.22 from pot",
      "*** SUMMARY ***",
      "Total pot $0.22 | Rake $0",
      "Seat 1: 9d7f4cb8 (big blind) collected ($0.22)",
      "Seat 2: 8d962552 (small blind) folded before Flop",
    ].join("\n");

  function firstHandOf(prefix: string): string {
    const file = sampleFiles("ggpoker").find((entry) => entry.name.startsWith(prefix));
    if (!file) {
      throw new Error(`fixture ${prefix} is missing from fixtures/samples/ggpoker/`);
    }
    return ggpokerParser.splitHands(file.text)[0];
  }

  it("splits the tournament name from the game label by the label, not the buy-in", () => {
    // The killer is file 30: the *name* contains the phrase "No Limit Hold'em"
    // and a second money amount, so splitting the header on its first money
    // token reads the name as `WSOP #77:` and the game label as
    // `No Limit Hold'em Main Event [Flight W], $25M GTD Hold'em No Limit`.
    // The game label is a closed vocabulary and always sits last, so it is
    // matched from the end instead.
    const wsop = ggpokerParser.parseHand(firstHandOf("30-"), CTX);
    expect(wsop.game.label).toBe("Hold'em No Limit");
    expect(wsop.tournament).toMatchObject({
      id: "9364957",
      name: "WSOP #77: $5,000 No Limit Hold'em Main Event [Flight W], $25M GTD",
      buyIn: 500000,
      levelLabel: "10",
      // Comma-grouped blind levels: `Level10 (1,000/2,000)`.
      levelSmallBlind: 1000,
      levelBigBlind: 2000,
    });

    // File 27: a colon inside the name, a comma inside the buy-in, and a
    // confirmed triple space before the `- Level14(...)` clause.
    const ggMasters = ggpokerParser.parseHand(firstHandOf("27-"), CTX);
    expect(ggMasters.game.label).toBe("Hold'em No Limit");
    expect(ggMasters.tournament).toMatchObject({
      name: "H-04: $1,050 GGMasters High Rollers",
      buyIn: 105000,
      levelLabel: "14",
    });
  });

  it("reads comma-grouped chip counts", () => {
    const hand = ggpokerParser.parseHand(firstHandOf("27-"), CTX);
    // `Seat 2: e15d8ef6 (21,929 in chips)`
    expect(hand.players.find((player) => player.name === "e15d8ef6")?.startingStack).toBe(21929);
    expect(allInvariants(hand)).toEqual([]);
  });

  it("survives a fee line with no Rake column at all", () => {
    // Every hand in file 28 ends `Total pot N` with nothing after it. Code that
    // requires the six-column shape `gg-hh/` always prints reads no pot here.
    const hand = ggpokerParser.parseHand(firstHandOf("28-"), CTX);
    expect(hand.results.totalPot).toBeGreaterThan(0);
    expect(hand.results.fees).toEqual({
      rake: 0,
      jackpot: 0,
      bingo: 0,
      fortune: 0,
      tax: 0,
      other: 0,
    });
    expect(validateHand(hand).ok).toBe(true);
  });

  it("recognises a GG export whose hand id carries no product prefix", () => {
    // `Poker Hand #1171217378123557259: ShortDeck No Limit ($100)` - the id is
    // a bare number, so the prefix test cannot place it. `ShortDeck` as one
    // word is GG's own spelling (PokerStars calls it `6+ Hold'em`) and is
    // enough on its own.
    const file = sampleFiles("ggpoker").find((entry) => entry.name.startsWith("12-"))!;
    expect(ggpokerParser.detect(file.text)).toBe(0.95);
    // ...and it is then refused, because short deck is a 36-card game.
    try {
      ggpokerParser.parseHand(firstHandOf("12-"), CTX);
      throw new Error("short deck was converted");
    } catch (error) {
      expect((error as ParseSkip).reason).toBe("unsupported-variant");
    }
  });

  it("accounts for a house-funded cash drop instead of refusing the hand", () => {
    // `Cash Drop to Pot : total $0.2` puts money in the pot that came from no
    // player. It can be neither a contribution - that corrupts a seat's `net` -
    // nor a negative fee, which would have the replayer pay out more than the
    // pot holds, so this hand used to be refused outright. `PhfChipMovement`
    // gave it an honest home: chip conservation counts house-into-pot money and
    // the replayer seeds the pot with it, so the hand converts.
    const text = CASH_DROP_HAND;
    const hand = ggpokerParser.parseHand(text, CTX);
    expect(validateHand(hand).ok).toBe(true);
    expect(hand.chipMovements).toEqual([
      {
        kind: "cash-drop",
        fromSeat: null,
        fromPlayer: null,
        toPot: true,
        amount: 20,
        raw: "Cash Drop to Pot : total $0.2",
        anchor: "before-postings",
      },
    ]);
    // $0.01 small blind + $0.01 called big blind + $0.20 from the house. The
    // seats put in 2 between them; the pot is 22 and the winner collects it.
    expect(hand.results.totalPot).toBe(22);
    expect(hand.results.winners[0].amount).toBe(22);
    // It stays off the action stream, so no seat is credited with house money.
    expect(hand.actions.some((action) => /Cash Drop/.test(action.rawLine))).toBe(false);
    expect(hand.meta.warnings).toEqual([]);
    expect(toStandardText(hand).trim()).toBe(text.trim());
    expect(allInvariants(hand)).toEqual([]);
  });

  it("records Rush & Cash as a fast-fold pool", () => {
    // The pool is announced by the `RC` product code in the hand id, never by
    // the pretty table name (`NLHPurple70` says nothing about it), and
    // `game.label` drops the distinction on the way through canonicalisation -
    // hence `PhfTable.fastFold`.
    //
    // Asserted on the reconstruction above rather than the corpus because the
    // only real `RC` fixture is Omaha and is refused before a table line is
    // read. The `RC` prefix itself is quoted from that fixture.
    const rushAndCash = ggpokerParser.parseHand(CASH_DROP_HAND, CTX);
    expect(rushAndCash.meta.handId.startsWith("RC")).toBe(true);
    expect(rushAndCash.table.fastFold).toBe("Rush & Cash");

    // An ordinary GG cash table is not a fast-fold pool and must not claim to
    // be - the whole corpus of `HD` hands has to stay clean of the label.
    const ordinary = PARSED.filter((entry) => entry.hand?.meta.handId.startsWith("HD"));
    expect(ordinary.length).toBeGreaterThan(400);
    expect(ordinary.every((entry) => (entry.hand!.table.fastFold ?? null) === null)).toBe(true);
  });

  it("reads GG's bare straddle verb, which has no 'posts'", () => {
    // Real GG writes `27925b27: straddle $0.04`, not PokerStars'
    // `X: posts straddle $4`. Every straddle in the fpdb corpus is on a PLO-5
    // or ShortDeck table, which this parser refuses before it reads a single
    // action line, so the Hold'em hand below is a reconstruction of that verb -
    // but the verb itself is quoted from fixtures 11 and 19.
    const hand = ggpokerParser.parseHand(
      [
        "Poker Hand #RC2600000011: Hold'em No Limit ($0.01/$0.02) - 2021/03/01 10:00:00",
        "Table 'RushAndCash1' 6-max Seat #1 is the button",
        "Seat 1: 27925b27 ($2 in chips)",
        "Seat 2: 8d962552 ($2 in chips)",
        "Seat 3: Hero ($2 in chips)",
        "8d962552: posts small blind $0.01",
        "Hero: posts big blind $0.02",
        "27925b27: straddle $0.04",
        "*** HOLE CARDS ***",
        "Dealt to 27925b27 ",
        "Dealt to 8d962552 ",
        "Dealt to Hero [Ac Kh]",
        "8d962552: folds",
        "Hero: folds",
        "Uncalled bet ($0.02) returned to 27925b27",
        "*** SHOWDOWN ***",
        "27925b27: doesn't show hand",
        "27925b27 collected $0.05 from pot",
        "*** SUMMARY ***",
        "Total pot $0.05 | Rake $0",
        "Seat 1: 27925b27 (button) collected ($0.05)",
        "Seat 2: 8d962552 (small blind) folded before Flop",
        "Seat 3: Hero (big blind) folded before Flop",
      ].join("\n"),
      CTX,
    );
    expect(validateHand(hand).ok).toBe(true);
    // The money has to reach the pot; a parser that only knows `posts straddle`
    // drops the line entirely and the hand fails chip conservation instead.
    expect(hand.game.straddles).toEqual([
      { seat: 1, player: "27925b27", amount: 4, order: 1 },
    ]);
    const straddle = hand.actions.find((action) => action.type === "straddle")!;
    expect(straddle.amount).toBe(4);
    expect(straddle.streetTotal).toBe(4);
    expect(straddle.verb).toBe("straddle");
    expect(hand.meta.warnings).toEqual([]);

    // The full round trip holds too, now that the serializer reads the bare
    // verb back. `toStandardText` always wrote it correctly (it emits
    // `verb ?? "posts"`), but `parseStandardHand` used to accept only
    // `^(.+?): posts (straddle )?N$` and so could not read its own output -
    // which dropped the straddle and its chips. Closed in `phf/serialize.ts`
    // by widening that alternation to `(posts straddle|straddle|posts)`.
    expect(roundTripsThroughStandardText(hand)).toEqual([]);
    expect(allInvariants(hand)).toEqual([]);
  });

  it("records all-in insurance without pretending it is an EV cashout", () => {
    // Real GG, verified by inspection in fixture 15 (a PLO hand, hence the
    // reconstruction here on Hold'em). Insurance is a different product from
    // EV Cashout - the player keeps their equity and pays a premium to hedge
    // it - and `ActionType` has no member for it, so it is recorded verbatim
    // rather than reported under the cashout vocabulary. Either way the pot is
    // untouched, because the premium settles with GG.
    const hand = ggpokerParser.parseHand(
      [
        "Poker Hand #HD2600000010: Hold'em No Limit ($0.5/$1) - 2020/04/14 07:58:23",
        "Table 'NLHBronze12' 6-max Seat #2 is the button",
        "Seat 1: 23aca38f ($17 in chips)",
        "Seat 2: Hero ($90 in chips)",
        "23aca38f: posts small blind $0.5",
        "Hero: posts big blind $1",
        "*** HOLE CARDS ***",
        "Dealt to 23aca38f ",
        "Dealt to Hero [Ac Kh]",
        "23aca38f: raises $16 to $17 and is all-in",
        "Hero: calls $16",
        "23aca38f: shows [6s Jd]",
        "Hero: shows [Ac Kh]",
        "23aca38f: get an all-in insurance (premium ($0/$4/$0) for ($0/$10.8/$0) - (Mandatory/Main/Sub))",
        "*** FLOP *** [6c Kd Qc]",
        "23aca38f: pay premium of all-in insurance ($4)",
        "*** TURN *** [6c Kd Qc] [3s]",
        "*** RIVER *** [6c Kd Qc 3s] [6h]",
        "*** SHOWDOWN ***",
        "23aca38f collected $34 from pot",
        "*** SUMMARY ***",
        "Total pot $34",
        "Board [6c Kd Qc 3s 6h]",
        "Seat 1: 23aca38f (small blind) showed [6s Jd] and won ($34) with two pair",
        "Seat 2: Hero (button) (big blind) showed [Ac Kh] and lost with a pair of Kings",
      ].join("\n"),
      CTX,
    );
    expect(validateHand(hand).ok).toBe(true);
    // Not folded into the cashout path: no cashout action, no cashout risk.
    expect(hand.actions.some((action) => action.type.startsWith("cashout"))).toBe(false);
    expect(hand.results.players.every((seat) => seat.cashoutRisk === null)).toBe(true);
    // Recorded, attributable, and visible rather than silently dropped.
    const insurance = hand.meta.warnings.filter(
      (warning) => warning.code === "all-in-insurance",
    );
    expect(insurance).toHaveLength(2);
    expect(insurance[0].message).toContain("get an all-in insurance");
    expect(insurance[1].message).toContain("pay premium of all-in insurance");
    // The premium settles with GG, so the pot arithmetic is untouched.
    expect(hand.results.totalPot).toBe(3400);
    expect(allInvariants(hand)).toEqual([]);
  });
});

describe("GGPoker refusals", () => {
  it("refuses Omaha, Short Deck and anything else that is not Hold'em", () => {
    const omaha = [
      "Poker Hand #OM2600000009: Omaha Pot Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
      "Table 'PLOBlue1' 6-max Seat #1 is the button",
      "Seat 1: aaaaaaaa ($50 in chips)",
      "Seat 2: bbbbbbbb ($50 in chips)",
    ].join("\n");
    expect(() => ggpokerParser.parseHand(omaha, CTX)).toThrow(/not supported/);
    try {
      ggpokerParser.parseHand(omaha, CTX);
    } catch (error) {
      expect((error as ParseSkip).reason).toBe("unsupported-variant");
    }
  });

  it("refuses Short Deck, which GG sells as 6+ Hold'em", () => {
    // The label contains "Hold'em", so a variant test that looks for that word
    // first happily converts a 36-card game as if it were a 52-card one.
    const shortDeck = [
      "Poker Hand #SD2600000009: 6+ Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00",
      "Table 'ShortDeck1' 6-max Seat #1 is the button",
      "Seat 1: aaaaaaaa ($50 in chips)",
    ].join("\n");
    try {
      ggpokerParser.parseHand(shortDeck, CTX);
      throw new Error("short deck was converted");
    } catch (error) {
      expect((error as ParseSkip).reason).toBe("unsupported-variant");
    }
    // It is still claimed, so the refusal is recorded against GG rather than
    // landing in the generic reader and being converted as Hold'em.
    expect(ggpokerParser.detect(shortDeck)).toBe(0.95);
  });

  it("refuses a hand with no seat block rather than inventing one", () => {
    const headerOnly = "Poker Hand #HD1: Hold'em No Limit ($0.25/$0.5) - 2026/03/01 10:00:00";
    expect(() => ggpokerParser.parseHand(headerOnly, CTX)).toThrow();
  });
});

describe("GGPoker through the pipeline", () => {
  it("is registered", () => {
    expect(getParser("ggpoker")?.name).toBe("GGPoker");
  });

  it("converts a forced GG upload end to end", async () => {
    const file = ggCorpusFiles()[0];
    const result = await convertAny(file.text, {
      sourceFilename: file.name,
      siteId: "ggpoker",
    });
    expect(result.failures).toEqual([]);
    expect(result.stats.bySite).toEqual({ ggpoker: result.hands.length });
    expect(result.hands.length).toBeGreaterThan(50);
  });

  it("does not disturb the PokerStars corpus", () => {
    // Fixture 29 is a headerless fragment that nobody claims; every other
    // PokerStars sample has to reach the PokerStars parser, not this one.
    const misrouted = sampleFiles("pokerstars")
      .filter((file) => pokerstarsParser.detect(file.text) > 0)
      .filter((file) => detectSite(file.text)[0]?.parser.id !== "pokerstars");
    expect(misrouted.map((file) => file.relativePath)).toEqual([]);
  });
});
