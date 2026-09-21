/**
 * Full Tilt Poker, Run It Once Poker and PokerBros, over their whole corpora.
 *
 * Table driven over the sample directories rather than over hands somebody
 * picked: the value of a corpus is the line shape nobody thought of, and that
 * only surfaces if every file runs every time.
 *
 * Which site a file belongs to is decided **from its text**, never from the
 * directory it sits in - the same rule `p2Parsers.test.ts` uses, and for the
 * same reason: harvested corpora do get filed under the wrong room, and a test
 * that trusts the folder name would confirm the mistake instead of catching it.
 *
 * The assertions are the real invariants: no unrecognised source line, chip
 * conservation, no negative stack mid-hand, the whole pot paid out, a clean
 * round trip through standard text, and a refusal reason for everything we will
 * not convert.
 */

import { describe, expect, it } from "vitest";

import {
  convertAny,
  detectSite,
  fulltiltParser,
  pokerbrosParser,
  runitonceParser,
} from "../../frontend/src/lib/parsers/index.js";
import { ParseSkip } from "../../frontend/src/lib/phf/detect.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  contributionsFromActions,
  houseIntoPot,
  totalFees,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import { otherSampleSites, sampleFiles, type SampleFile } from "./support/p2Corpus.js";
import { BLIND_SPOT_CODES, allInvariants } from "./support/psggInvariants.js";

const CTX = { sourceFilename: null, options: {} };

/** Sample directories these three parsers own. */
const MY_DIRS = ["full-tilt", "run-it-once", "pokerbros"];

interface Site {
  id: string;
  name: string;
  /** The sample directory this room's files are supposed to live in. */
  dir: string;
  parser: typeof fulltiltParser;
  /** What the *text* of a file has to contain to belong to this room. */
  signature: RegExp;
  /** Refusal reasons this parser is allowed to produce. Deliberately closed. */
  reasons: string[];
  /** `meta.handKey` prefix; ids from these rooms are bare integers. */
  keyPrefix: string;
}

const SITES: Site[] = [
  {
    id: "fulltilt",
    name: "Full Tilt Poker",
    dir: "full-tilt",
    parser: fulltiltParser,
    signature: /^Full Tilt Poker Game #\d+:/m,
    reasons: [
      // Round one is Hold'em; four of the fourteen fixtures are Omaha.
      "unsupported-variant",
      // A header and a SUMMARY block with no seat listing (fixture 13).
      "no-seat-block",
      // Never confirmed, never invented. See the parser's header comment.
      "tournament-unsupported",
      "unsupported-currency",
      "hand-cancelled",
      "normalized-unparseable",
      "unseated-actor",
    ],
    keyPrefix: "FT",
  },
  {
    id: "runitonce",
    name: "Run It Once Poker",
    dir: "run-it-once",
    parser: runitonceParser,
    signature: /^Run It Once Poker (?:Hand|Tournament) #\d+/m,
    reasons: [
      "unsupported-variant",
      // A tournament *summary* file is RIO's, but it holds no hands.
      "no-hands",
      "no-seat-block",
      "unsupported-currency",
      "normalized-unparseable",
      "unseated-actor",
    ],
    keyPrefix: "RIO",
  },
  {
    id: "pokerbros",
    name: "PokerBros",
    dir: "pokerbros",
    parser: pokerbrosParser,
    signature: /^PokerBros Hand #\d+:|^\*{3,}\s*Hand History for Game\s+\d+\s*\*{3,}\s*\(PokerBros\)/m,
    reasons: [
      "unsupported-variant",
      "no-seat-block",
      "too-few-players",
      "inconsistent-pot",
      "normalized-unparseable",
      "unsupported-currency",
      "unseated-actor",
    ],
    keyPrefix: "PB",
  },
];

/**
 * Warnings these parsers may legitimately raise.
 *
 * Closed on purpose: a warning is how "I handled this but it was odd" reaches
 * the user, so a new one has to be a deliberate decision rather than something
 * that appears because a source line drifted.
 */
const ALLOWED_WARNINGS = new Set([
  // Full Tilt prints one SUMMARY block per runout of a run-it-twice hand.
  "run-it-twice-summary",
  // PokerBros' PokerStars-dialect converter puts the button on an empty seat.
  "button-seat-empty",
  // Its party-dialect converter deals the face-up cards to the wrong seat.
  "hero-attribution",
  "ambiguous-timestamp",
  "unknown-timezone",
  // Run It Once folds its Splash-the-Pot chips into the figure it prints on the
  // uncalled-bet line, and states them again in the SUMMARY.
  "uncalled-includes-promo",
  "house-chips-mismatch",
  // Raised by the shared builders when a source states no SUMMARY block.
  "rake-inferred",
  "no-summary",
  "board-from-summary",
]);

/** Every sample in the tree, wherever it is filed. */
function allSamples(): SampleFile[] {
  return [...MY_DIRS, ...otherSampleSites(MY_DIRS)].flatMap((dir) => sampleFiles(dir));
}

/** The samples whose *text* says they belong to `site`. */
function siteFiles(site: Site): SampleFile[] {
  return allSamples().filter((file) => site.signature.test(file.text));
}

function eachFile(site: Site): Array<readonly [string, SampleFile]> {
  return siteFiles(site).map((file) => [file.relativePath, file] as const);
}

/** Everything the seated players put in, net of uncalled returns. */
function contributionsOf(hand: PhfHand): number {
  return [...contributionsFromActions(hand).values()].reduce((sum, value) => sum + value, 0);
}

/** Parses one fixture by name prefix, so a renamed file fails loudly. */
function handsOf(dir: string, prefix: string, parser: Site["parser"]): PhfHand[] {
  const file = sampleFiles(dir).find((entry) => entry.name.startsWith(prefix));
  if (!file) {
    throw new Error(`fixture ${prefix} is missing from fixtures/samples/${dir}/`);
  }
  return parser.splitHands(file.text).map((chunk) => parser.parseHand(chunk, CTX));
}

/** The refusal a fixture produces, for the hands we deliberately do not convert. */
function skipFor(dir: string, prefix: string, parser: Site["parser"]): ParseSkip {
  const file = sampleFiles(dir).find((entry) => entry.name.startsWith(prefix));
  if (!file) {
    throw new Error(`fixture ${prefix} is missing from fixtures/samples/${dir}/`);
  }
  try {
    parser.parseHand(parser.splitHands(file.text)[0] ?? file.text, CTX);
  } catch (error) {
    return error as ParseSkip;
  }
  throw new Error(`${prefix} was expected to be refused`);
}

/* ------------------------------------------------------------ the corpora - */

for (const site of SITES) {
  const files = eachFile(site);

  describe(`${site.name} corpus`, () => {
    it("finds its corpus", () => {
      expect(files.length).toBeGreaterThan(0);
      // Every file the text attributes to this room is filed under its own
      // directory. The reverse - a foreign file in this directory - is what the
      // cross-detection block below catches.
      expect(files.filter((entry) => !entry[0].includes(`/${site.dir}/`))).toEqual([]);
    });

    it.each(files)("%s is attributed to its own parser", (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe(site.id);
      expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
      // Nobody else may claim it at all: these are all PokerStars-family
      // grammars, so a second claimant would be a parser reading another room's
      // hand with the wrong dialect.
      expect(ranked.map((candidate) => candidate.parser.id)).toEqual([site.id]);
    });

    it.each(files)("%s converts or refuses with a machine readable reason", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      expect(result.stats.total).toBeGreaterThan(0);

      for (const failure of result.failures) {
        expect(site.reasons, `${failure.reason}: ${failure.message}`).toContain(failure.reason);
        expect(failure.detectedSite).toBe(site.id);
        expect(failure.message.length).toBeGreaterThan(10);
        expect(failure.rawText.length).toBeGreaterThan(0);
      }

      for (const hand of result.hands) {
        const where = `${file.name} ${hand.meta.handId}`;
        expect(hand.meta.siteId, where).toBe(site.id);
        expect(hand.meta.parserId, where).toBe(site.id);
        expect(hand.meta.parserVersion, where).toBe(site.parser.version);
        expect(hand.meta.handKey, where).toBe(`${site.keyPrefix}${hand.meta.handId}`);
        expect(hand.meta.rawText.length, where).toBeGreaterThan(0);
        expect(hand.game.variant, where).toBe("holdem");
        expect(validateHand(hand).errors, where).toEqual([]);
      }
    });

    it.each(files)("%s leaves no source line unread", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      const blind = result.hands.flatMap((hand) =>
        hand.meta.warnings
          .filter((warning) => BLIND_SPOT_CODES.includes(warning.code))
          .map((warning) => `${hand.meta.handId} line ${warning.line}: ${warning.message}`),
      );
      expect(blind).toEqual([]);
      const unexpected = result.hands.flatMap((hand) =>
        hand.meta.warnings
          .filter((warning) => !ALLOWED_WARNINGS.has(warning.code))
          .map((warning) => `${hand.meta.handId} ${warning.code}: ${warning.message}`),
      );
      expect(unexpected).toEqual([]);
    });

    it.each(files)("%s holds every invariant in every hand", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        expect(allInvariants(hand), `${file.name} ${hand.meta.handId}`).toEqual([]);
      }
    });

    it.each(files)("%s pays the whole pot out and never goes below zero", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const where = `${file.name} ${hand.meta.handId}`;
        const paid = hand.results.winners.reduce((sum, winner) => sum + winner.amount, 0);
        // All three rooms report a pot the rake has already come out of.
        expect(paid + totalFees(hand.results.fees), `${where} out`).toBe(hand.results.totalPot);
        // What the players put in plus what the house dropped in is the pot.
        expect(contributionsOf(hand) + houseIntoPot(hand), `${where} in`).toBe(
          hand.results.totalPot,
        );
        expect(hand.results.fees.rake, `${where} rake`).toBeGreaterThanOrEqual(0);

        const frames = buildReplay(hand);
        expect(frames.length, where).toBeGreaterThan(0);
        for (const frame of frames) {
          for (const seat of frame.seats) {
            expect(seat.stack, `${where} ${seat.name}`).toBeGreaterThan(-0.005);
          }
        }
        if (hand.results.winners.length > 0) {
          expect(frames[frames.length - 1].pot, where).toBe(0);
        }
      }
    });
  });
}

/* ------------------------------------------------------------- Full Tilt - */

describe("Full Tilt", () => {
  it("reads both header generations", () => {
    // 2014: `Table Goldring (heads up) - NL Hold'em - $5/$10 - ...`
    // 2011: `Table Bri (6 max) - $0.25/$0.50 - $15 Cap No Limit Hold'em - ...`
    // The stakes and the game type swap places, and a parser that reads only one
    // of them misreads every hand from the other era.
    const [modern] = handsOf("full-tilt", "01-", fulltiltParser);
    expect(modern.game.label).toBe("NL Hold'em");
    expect([modern.game.smallBlind, modern.game.bigBlind]).toEqual([500, 1000]);
    expect(modern.table.name).toBe("Goldring");
    expect(modern.table.maxSeats).toBe(2);

    const [legacy] = handsOf("full-tilt", "06-", fulltiltParser);
    expect(legacy.game.label).toBe("$15 Cap No Limit Hold'em");
    expect([legacy.game.smallBlind, legacy.game.bigBlind]).toEqual([25, 50]);
    expect(legacy.table.name).toBe("Bri");
    expect(legacy.table.maxSeats).toBe(6);
  });

  it("reads the `of`-phrased uncalled return", () => {
    // `Uncalled bet of $20 returned to X`, not PokerStars' `(bet)` form. A
    // parser that misses the line keeps the $20 in the pot, and the hand then
    // balances against a pot that is $20 too big.
    const [hand] = handsOf("full-tilt", "01-", fulltiltParser);
    const uncalled = hand.actions.find((action) => action.type === "uncalled");
    expect(uncalled?.amount).toBe(-2000);
    expect(uncalled?.player).toBe("Rene Lacoste");
    expect(hand.results.totalPot).toBe(4000);
  });

  it("does not read `and is capped` as all-in", () => {
    // A CAP table caps the betting, which is not the same thing as a player
    // being out of chips; calling it all-in would end the betting round early
    // in the replayer and mislabel the hand as an all-in confrontation.
    const [hand] = handsOf("full-tilt", "02-", fulltiltParser);
    const capped = hand.actions.filter((action) => /capped/.test(action.rawLine));
    expect(capped.length).toBe(2);
    expect(capped.every((action) => action.allIn)).toBe(false);
  });

  it("splits a run-it-twice hand into two runouts and pays one pot to each", () => {
    const [hand] = handsOf("full-tilt", "02-", fulltiltParser);
    expect(hand.board.runouts).toHaveLength(2);
    // The second runout re-deals the river only; the flop and turn are shared,
    // which is exactly what `null` means on a runout past the first.
    expect(hand.board.runouts[1].flop).toBeNull();
    expect(hand.board.runouts[1].turn).toBeNull();
    expect(hand.board.runouts[1].river).toBe("2h");
    // `wins pot 1` and `wins pot 2` are both printed after `*** SHOW DOWN 2 ***`,
    // so the runout has to come from the pot number and not from the marker the
    // collect happens to sit under.
    expect(hand.results.winners).toEqual([
      { player: "Darkking_pt", seat: 6, amount: 31100, runoutIndex: 0 },
      { player: "1mperial", seat: 4, amount: 31100, runoutIndex: 1 },
    ]);
    expect(hand.meta.textStyle.runItTwiceNote).toBe(true);
  });

  it("keeps the fold streets the SUMMARY block states", () => {
    // Full Tilt writes `folded before the Flop` and `didn't bet (folded)` where
    // the family writes `folded before Flop` and a `(didn't bet)` marker; an
    // unrecognised wording silently loses the fold street for every seat.
    const [hand] = handsOf("full-tilt", "02-", fulltiltParser);
    const bySeat = new Map(hand.results.players.map((player) => [player.seat, player]));
    expect(bySeat.get(3)?.foldedStreet).toBe("preflop");
    expect(bySeat.get(2)?.foldedStreet).toBe("flop");
    expect(bySeat.get(5)?.didntBet).toBe(true);
  });

  it("takes fixed-limit blinds from what was posted, not from the header", () => {
    // `FL Hold'em - $0.05/$0.10` states the small and big *bet*; the blinds on
    // that table are $0.02/$0.05, and the header numbers would overstate every
    // stack in big blinds by a factor of two.
    const [hand] = handsOf("full-tilt", "07-", fulltiltParser);
    expect(hand.game.limit).toBe("fl");
    expect([hand.game.smallBlind, hand.game.bigBlind]).toEqual([2, 5]);
  });

  it("leaves a sitting-out seat out of the position ring", async () => {
    // Nine seats, one of them sitting out and not dealt in. Counting it shifts
    // every position behind it by one - the cutoff becomes the hijack - and
    // every position filter built on the hand is then wrong. The ring is the
    // core's to resolve, so this goes through `convertAny` rather than the
    // parser, which is also what proves the parser hands the core what it needs.
    const file = sampleFiles("full-tilt").find((entry) => entry.name.startsWith("05-"))!;
    const { hands } = await convertAny(file.text, { sourceFilename: file.name });
    const positions = new Map(hands[0].players.map((player) => [player.seat, player.position]));
    expect(positions.get(8)).toBeNull();
    expect(positions.get(7)).toBe("UTG");
    expect(positions.get(9)).toBe("UTG+1");
    expect(positions.get(4)).toBe("BTN");
    expect(positions.get(5)).toBe("SB");
  });

  it("splits a multi-hand file on the header, not on the blank lines", () => {
    // The file separates hands with two blank lines, and the corpus's own copy
    // duplicates each hand once. Splitting on the header covers both.
    const hands = handsOf("full-tilt", "05-", fulltiltParser);
    expect(hands).toHaveLength(10);
    expect(new Set(hands.map((hand) => hand.meta.handId)).size).toBe(5);
  });

  it("keeps table chat out of the action stream", () => {
    // Full Tilt action lines carry no colon, so `pupsaa: idi0t lucker` is the
    // only line shape that can be confused with one. The hand is Omaha, so this
    // runs the chat line through the parser directly.
    const text = [
      "Full Tilt Poker Game #1: Table Vernon - NL Hold'em - $0.50/$1 - 15:45:47 ET - 2014/01/06",
      "Seat 5: WTFseeB8 ($114.95)",
      "Seat 6: pupsaa ($60.30)",
      "WTFseeB8 posts the small blind of $0.50",
      "pupsaa posts the big blind of $1",
      "The button is in seat #5",
      "*** HOLE CARDS ***",
      "pupsaa: idi0t lucker",
      "WTFseeB8 folds",
      "Uncalled bet of $0.50 returned to pupsaa",
      "pupsaa mucks",
      "pupsaa wins the pot ($1)",
      "*** SUMMARY ***",
      "Total pot $1 | Rake $0",
      "Seat 5: WTFseeB8 (small blind) folded before the Flop",
      "Seat 6: pupsaa (big blind) collected ($1), mucked",
    ].join("\n");
    const hand = fulltiltParser.parseHand(text, CTX);
    expect(hand.meta.warnings).toEqual([]);
    expect(hand.actions.some((action) => action.rawLine.includes("idi0t"))).toBe(false);
    expect(validateHand(hand).errors).toEqual([]);
  });

  it("refuses a hand that has no seat listing", () => {
    // Fixture 13 is a header plus a SUMMARY block: real, and unconvertible,
    // because the seats it names have no stacks and no actions.
    const skip = skipFor("full-tilt", "13-", fulltiltParser);
    expect(skip.reason).toBe("no-seat-block");
  });

  it("refuses every Omaha hand by reading the header, not by accident", () => {
    for (const [fixture, label] of [
      ["03-", "PL Omaha H/L"],
      ["08-", "FL Omaha H/L"],
      ["11-", "PL Omaha Hi"],
      ["14-", "PL Omaha H/L"],
    ] as const) {
      const skip = skipFor("full-tilt", fixture, fulltiltParser);
      expect(skip.reason).toBe("unsupported-variant");
      expect(skip.message).toContain(label);
    }
  });

  it("refuses a tournament rather than inventing a grammar for one", () => {
    // No Full Tilt tournament hand history has ever been recovered - not in this
    // corpus, not publicly, and the reference parser the research came from
    // never implemented one. A guessed grammar would produce hands that look
    // right and are not, so the refusal is the feature.
    const skip = (() => {
      try {
        fulltiltParser.parseHand(
          "Full Tilt Poker Game #1: $10 + $1 Sit & Go (123456), Table 1 - 15/30 - " +
            "No Limit Hold'em - 20:00:00 ET - 2010/01/01\nSeat 1: x (1500)",
          CTX,
        );
      } catch (error) {
        return error as ParseSkip;
      }
      throw new Error("a tournament hand was expected to be refused");
    })();
    expect(skip.reason).toBe("tournament-unsupported");
    expect(skip.message).toContain("unconfirmed");
  });

  it("refuses a cancelled hand", () => {
    const skip = (() => {
      try {
        fulltiltParser.parseHand(
          [
            "Full Tilt Poker Game #2: Table Bri (6 max) - NL Hold'em - $0.25/$0.50 - " +
              "18:46:08 ET - 2011/02/28",
            "Seat 1: a ($56.15)",
            "Seat 2: b ($36.60)",
            "a posts the small blind of $0.25",
            "Hand #2 has been canceled",
          ].join("\n"),
          CTX,
        );
      } catch (error) {
        return error as ParseSkip;
      }
      throw new Error("a cancelled hand was expected to be refused");
    })();
    expect(skip.reason).toBe("hand-cancelled");
  });

  it("does not claim a headerless fragment", async () => {
    // Fixture 09 is a few posting lines with no header. It cannot be attributed
    // to any room, and claiming it would mean converting an unknown site's text.
    const file = sampleFiles("full-tilt").find((entry) => entry.name.startsWith("09-"))!;
    expect(fulltiltParser.detect(file.text)).toBe(0);
    expect(detectSite(file.text)).toEqual([]);
    const result = await convertAny(file.text, { sourceFilename: file.name });
    expect(result.failures[0]?.reason).toBe("unknown-site");
  });
});

/* ---------------------------------------------------------- Run It Once - */

describe("Run It Once Poker", () => {
  it("reads the one-word SHOWDOWN marker and the Table ID line", () => {
    // RIO writes `*** SHOWDOWN ***` where PokerStars writes `*** SHOW DOWN ***`,
    // and `Table ID '55582350' 3-Max` where PokerStars writes `Table 'name'
    // 3-max`. Both are trivial to miss when bootstrapping from a PokerStars
    // parser, and missing either loses the showdown or the button.
    const [hand] = handsOf("run-it-once", "03-", runitonceParser);
    expect(hand.meta.textStyle.showdownSection).toBe(true);
    expect(hand.table.name).toBe("55582350");
    expect(hand.table.maxSeats).toBe(3);
    expect(hand.table.buttonSeat).toBe(5);
  });

  it("puts the uncalled return back on the street it was bet on", () => {
    // RIO prints `Uncalled bet (80) returned to X` *below* the showdown marker.
    // Left there, the return is measured against a street the player committed
    // nothing on, which is precisely `uncalled-exceeds-commitment`.
    const [hand] = handsOf("run-it-once", "03-", runitonceParser);
    const uncalled = hand.actions.find((action) => action.type === "uncalled");
    expect(uncalled?.street).toBe("turn");
    expect(uncalled?.amount).toBe(-80);
    expect(validateHand(hand).errors).toEqual([]);
  });

  it("reads a tournament header that has no level and does have a name", () => {
    const [hand] = handsOf("run-it-once", "03-", runitonceParser);
    expect(hand.game.format).toBe("tournament");
    expect(hand.game.unit.kind).toBe("chips");
    expect(hand.tournament).toMatchObject({
      id: "158168",
      name: "Cub3d",
      // €4.69 + €0.31: real money, in a different unit from the chips.
      buyIn: 469,
      fee: 31,
      levelLabel: null,
      levelSmallBlind: 10,
      levelBigBlind: 20,
    });
    expect(hand.tournament?.buyInUnit.code).toBe("EUR");
    expect([hand.game.smallBlind, hand.game.bigBlind]).toEqual([10, 20]);
    expect(hand.playedAt).toBe("2021-04-12T16:01:00.000Z");
  });

  it("names the hero from the seat tag rather than the first deal line", () => {
    // RIO deals every seat face up in these exports, so the usual "whoever has
    // cards is the hero" rule would make the first seat listed the hero. The
    // `[hero]` tag is the only true marker.
    const [hand] = handsOf("run-it-once", "03-", runitonceParser);
    expect(hand.players.filter((player) => player.isHero).map((player) => player.name)).toEqual([
      "Doc",
    ]);
    expect(hand.results.heroNet).toBe(-40);
  });

  it("books Splash-the-Pot chips as house money rather than a player's bet", () => {
    // `STP added: €0.50` is money the room itself puts in: no seat contributed
    // it and the winner collects it. It is a `PhfChipMovement`, not an action -
    // charging it to a seat would corrupt that player's net and everything
    // computed from it - and the validator counts it into the pot, so
    // conservation holds as contributions + house === totalPot.
    const [hand] = handsOf("run-it-once", "01-", runitonceParser);
    expect(hand.chipMovements).toEqual([
      {
        kind: "splash-the-pot",
        fromSeat: null,
        fromPlayer: null,
        toPot: true,
        amount: 50,
        raw: "STP added: €0.50",
        anchor: "after-hole-cards",
      },
    ]);
    expect(hand.results.totalPot).toBe(75);
    expect(contributionsOf(hand)).toBe(25);
    expect(validateHand(hand).errors).toEqual([]);

    // The winner put in one big blind and took the splash with it.
    const winner = hand.results.players.find((player) => player.player === "Galen U")!;
    expect([winner.contributed, winner.won, winner.net]).toEqual([10, 71, 61]);
  });

  it("caps an uncalled return that the room inflated with the splash", () => {
    // RIO prints `Uncalled bet (€0.71) returned to Galen U` for a player who bet
    // €0.21 into a pot the house had added €0.50 to, and then hands him €0.71
    // again as the collect. Returning the printed figure would pay the splash
    // out twice and give back chips he never put in. The cap only applies when
    // the excess is *exactly* the promotional money, so any other overage still
    // fails loudly instead of being quietly trimmed.
    const [hand] = handsOf("run-it-once", "01-", runitonceParser);
    const uncalled = hand.actions.find((action) => action.type === "uncalled")!;
    expect(uncalled.amount).toBe(-21);
    expect(uncalled.street).toBe("flop");
    expect(hand.meta.warnings.map((warning) => warning.code)).toContain("uncalled-includes-promo");
  });

  it("round-trips the splash line through standard text", () => {
    // The drop has to survive serialization or the pot stops adding up on the
    // way back in; the serializer re-emits `movement.raw` at its anchor.
    const [hand] = handsOf("run-it-once", "01-", runitonceParser);
    const text = toStandardText(hand);
    expect(text).toContain("STP added: €0.50");
    const back = parseStandardHand(text, {
      siteId: "standard",
      siteName: "standard",
      originalFilename: null,
    })!;
    expect(back.chipMovements).toEqual(hand.chipMovements);
    expect(back.results.totalPot).toBe(hand.results.totalPot);
    expect(toStandardText(back)).toBe(text);
  });

  it("refuses the Omaha hand for its variant", () => {
    const skip = skipFor("run-it-once", "02-", runitonceParser);
    expect(skip.reason).toBe("unsupported-variant");
    expect(skip.message).toContain("Omaha Pot Limit");
  });

  it("claims a tournament summary file but finds no hands in it", async () => {
    // The summary is a separate export with the same brand line. Claiming it
    // means the upload is reported as "Run It Once Poker, no hands" instead of
    // as an unknown site, which is the difference between a user knowing their
    // file was the wrong one and thinking the room is unsupported.
    const file = sampleFiles("run-it-once").find((entry) => entry.name.startsWith("04-"))!;
    expect(runitonceParser.detect(file.text)).toBe(0.95);
    expect(runitonceParser.splitHands(file.text)).toEqual([]);
    const result = await convertAny(file.text, { sourceFilename: file.name });
    expect(result.failures[0]?.reason).toBe("no-hands");
    expect(result.failures[0]?.detectedSite).toBe("runitonce");
  });

  it("is not claimed by the PokerStars parser, and does not claim PokerStars", () => {
    const rio = sampleFiles("run-it-once")[0].text;
    expect(detectSite(rio).map((candidate) => candidate.parser.id)).toEqual(["runitonce"]);
    const stars = [
      "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
      "Table 'Aaltje II' 6-max Seat #2 is the button",
      "Seat 1: villain ($10 in chips)",
    ].join("\n");
    expect(runitonceParser.detect(stars)).toBe(0);
  });
});

/* ------------------------------------------------------------ PokerBros - */

describe("PokerBros", () => {
  /**
   * The two fixtures are the same real hand in two converter dialects, which is
   * the strongest check available for a room with no published native format:
   * two independent grammars have to produce the same money.
   */
  it("reads the same hand identically from both converter dialects", () => {
    const [party] = handsOf("pokerbros", "01-", pokerbrosParser);
    const [stars] = handsOf("pokerbros", "02-", pokerbrosParser);

    expect(party.results.totalPot).toBe(stars.results.totalPot);
    expect(party.results.fees.rake).toBe(stars.results.fees.rake);
    expect(party.game.smallBlind).toBe(stars.game.smallBlind);
    expect(party.game.bigBlind).toBe(stars.game.bigBlind);
    expect(party.board.runouts[0].flop).toEqual(stars.board.runouts[0].flop);
    expect(party.board.runouts[0].turn).toBe(stars.board.runouts[0].turn);
    expect(party.board.runouts[0].river).toBe(stars.board.runouts[0].river);

    // Seat numbers survive both dialects, so the per-seat money is comparable
    // even though one dialect names players and the other numbers them.
    const contributions = (hand: PhfHand) =>
      hand.results.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((player) => [player.seat, player.contributed, player.won]);
    expect(contributions(party)).toEqual(contributions(stars));
  });

  it("derives the pot and the rake the party dialect never states", () => {
    // Dialect A has no SUMMARY block at all: the file ends on the win line. The
    // pot is what went in and the rake is what the winner did not get back - and
    // the dialect-B twin states both, which is what makes this checkable.
    const [party] = handsOf("pokerbros", "01-", pokerbrosParser);
    expect(party.results.totalPot).toBe(24580);
    expect(party.results.fees.rake).toBe(425);
  });

  it("reads a party-dialect raise as a raise-to and a call as an increment", () => {
    // `Hero raises [$2.50]` is the total raised to, while `Player3 calls
    // [$2.00]` is the chips added. Reading the raise as an increment would put
    // $2.50 more in the pot than the table ever wagered.
    const [party] = handsOf("pokerbros", "01-", pokerbrosParser);
    const preflop = party.actions.filter((action) => action.street === "preflop");
    const raise = preflop.find((action) => action.type === "raise")!;
    expect(raise.streetTotal).toBe(250);
    expect(raise.amount).toBe(250);
    const call = preflop.find((action) => action.type === "call")!;
    expect(call.amount).toBe(200);
    expect(call.streetTotal).toBe(250);
  });

  it("flags the converter's hole-card attribution rather than correcting it", () => {
    // The party dialect names seat 1 `Hero` and deals the face-up cards to seat
    // 3, whose PokerStars-dialect twin holds two different cards. Nothing inside
    // the file says which is right, so the source is followed and the
    // disagreement is recorded where a user will see it.
    const [party] = handsOf("pokerbros", "01-", pokerbrosParser);
    expect(party.meta.warnings.map((warning) => warning.code)).toContain("hero-attribution");
  });

  it("reads a button the converter put on an empty seat", async () => {
    // The PokerStars-dialect converter puts the button on seat 2 of a table
    // whose occupied seats are 1, 3, 4, 5 and 6, while the dialect-A twin of the
    // same hand says seat 1.
    //
    // Leaving the printed number is not the harmless option it looks like: the
    // core reads a button on an unoccupied seat as a *dead* button - which is
    // right, CoinPoker really does keep `(button)` on a departed seat - names no
    // live seat BTN, and shifts everyone behind it, so seat 1 comes out as the
    // cutoff. A dead button and a made-up seat number are indistinguishable in
    // one export, so the parser corrects it only from the small blind, and only
    // to the seat that must hold the button if one was posted. The twin is what
    // proves this hand is the made-up case, and it agrees: seat 1.
    const [stars] = handsOf("pokerbros", "02-", pokerbrosParser);
    expect(stars.table.buttonSeat).toBe(1);
    const warning = stars.meta.warnings.find((entry) => entry.code === "button-seat-empty")!;
    // The source's own claim is never lost, even though it is not believed.
    expect(warning.message).toContain("seat 2");
    expect(warning.message).toContain("seat 1");

    const file = sampleFiles("pokerbros").find((entry) => entry.name.startsWith("02-"))!;
    const { hands } = await convertAny(file.text, { sourceFilename: file.name });
    const positions = new Map(hands[0].players.map((player) => [player.seat, player.position]));
    expect(positions.get(3)).toBe("SB");
    expect(positions.get(4)).toBe("BB");
    expect(positions.get(1)).toBe("BTN");

    // And now both dialects of the one hand agree on the button and the ring,
    // which is the whole reason to believe either of them.
    const [party] = handsOf("pokerbros", "01-", pokerbrosParser);
    expect(party.table.buttonSeat).toBe(stars.table.buttonSeat);
  });

  it("does not let the PartyGaming rooms claim its party dialect", () => {
    // The banner is partypoker's with `(PokerBros)` appended. 888 and
    // partypoker anchor their banner regex at the closing stars, so neither
    // matches - and this test is what keeps that true.
    const file = sampleFiles("pokerbros").find((entry) => entry.name.startsWith("01-"))!;
    expect(detectSite(file.text).map((candidate) => candidate.parser.id)).toEqual(["pokerbros"]);
  });

  it("re-serializes both dialects into readable standard text", () => {
    for (const prefix of ["01-", "02-"]) {
      const [hand] = handsOf("pokerbros", prefix, pokerbrosParser);
      const text = toStandardText(hand);
      expect(text).toContain("*** SUMMARY ***");
      expect(text).toContain("Total pot $245.80");
    }
  });
});

/* -------------------------------------------- detection is a shared space - */

describe("detection is a shared namespace", () => {
  const mine = SITES.map((site) => site.id);

  it.each(otherSampleSites(MY_DIRS).map((name) => [name] as const))(
    "no Full Tilt / RIO / PokerBros parser claims a %s sample",
    (dir) => {
      const claims: string[] = [];
      for (const file of sampleFiles(dir)) {
        for (const site of SITES) {
          const score = site.parser.detect(file.text);
          if (score > 0) {
            claims.push(`${site.id} claims ${file.relativePath} at ${score}`);
          }
        }
      }
      expect(claims).toEqual([]);
    },
  );

  it.each(MY_DIRS.map((name) => [name] as const))(
    "no other parser claims a %s sample",
    (dir) => {
      const claims: string[] = [];
      for (const file of sampleFiles(dir)) {
        for (const candidate of detectSite(file.text)) {
          if (!mine.includes(candidate.parser.id)) {
            claims.push(`${candidate.parser.id} claims ${file.relativePath}`);
          }
        }
      }
      expect(claims).toEqual([]);
    },
  );

  it("never throws, whatever it is handed", () => {
    for (const site of SITES) {
      for (const text of ["", " ", "hello", "Poker Hand #1:", "PokerStars Hand #1:", "*****"]) {
        expect(() => site.parser.detect(text)).not.toThrow();
        expect(() => site.parser.splitHands(text)).not.toThrow();
      }
    }
  });

  it("claims branding without a header only weakly", () => {
    // A truncated paste or a forum quote still names the room. It has to be
    // claimed weakly enough that a dedicated parser for whatever the text really
    // is would outrank it, and strongly enough to be reported as that room.
    expect(fulltiltParser.detect("posted on Full Tilt Poker in 2011")).toBe(0.3);
    expect(runitonceParser.detect("Run It Once Poker closed in 2022")).toBe(0.3);
    expect(pokerbrosParser.detect("a PokerBros club game")).toBe(0.3);
  });
});
