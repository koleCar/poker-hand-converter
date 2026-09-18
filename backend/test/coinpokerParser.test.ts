/**
 * CoinPoker parser suite.
 *
 * Table driven over `fixtures/samples/coinpoker/` - 16 real, byte-verified
 * files, no synthetic hands anywhere - plus the named-quirk cases the research
 * pass isolated one file each.
 *
 * Two deliberate choices, both copied from the PokerStars suite because they
 * caught real bugs there:
 *
 *  - **Site membership is decided from the text, not the directory.** Every
 *    hand fed to the parser has to carry a `CoinPoker Hand #` header; a
 *    mislabelled upstream fixture then shows up as an empty corpus rather than
 *    as a parser that happily converts another room's grammar.
 *  - **The invariants are re-derived from the action stream**, not read off the
 *    parser's own `results` block, so a parser that computed both from one
 *    broken number fails here rather than validating against itself.
 */

import { describe, expect, it } from "vitest";

import {
  coinpokerParser,
  convertAny,
  detectSite,
  getParsers,
  ParseSkip,
} from "../../frontend/src/lib/parsers/index.js";
import { looksLikeCoinPoker } from "../../frontend/src/lib/parsers/coinpoker.js";
import { toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { assignPositions, toBigBlinds, type PhfHand } from "../../frontend/src/lib/phf/types.js";
import {
  blindSpots,
  chipConservation,
  noNegativeStacks,
  potFullyAwarded,
  roundTripsThroughStandardText,
  seatsAndCards,
  uncalledWithinCommitment,
} from "./support/psggInvariants.js";
import { sampleFiles } from "./support/psggCorpus.js";

const SITE = "coinpoker";
const files = sampleFiles(SITE);

/** Every chunk in the corpus that is genuinely a CoinPoker hand, by its text. */
function corpusChunks(): Array<{ file: string; chunk: string }> {
  return files.flatMap((file) =>
    coinpokerParser
      .splitHands(file.text)
      .filter(looksLikeCoinPoker)
      .map((chunk) => ({ file: file.relativePath, chunk })),
  );
}

const chunks = corpusChunks();

/**
 * Parses a chunk, or returns the `ParseSkip` reason it was refused with.
 *
 * `assignPositions` is applied here because that is what `convertAny` does to
 * every parser's output: the draft deliberately leaves `position` null so the
 * ring is resolved once, centrally, from the posted blinds rather than per site.
 */
function parseOrSkip(chunk: string): PhfHand | { skipped: string } {
  try {
    const hand = coinpokerParser.parseHand(chunk, { sourceFilename: null, options: {} });
    assignPositions(hand);
    return hand;
  } catch (error) {
    if (error instanceof ParseSkip) {
      return { skipped: error.reason };
    }
    throw error;
  }
}

const parsed = chunks.map((entry) => ({ ...entry, result: parseOrSkip(entry.chunk) }));
const hands = parsed
  .map((entry) => entry.result)
  .filter((result): result is PhfHand => !("skipped" in result));

/** One fixture by name prefix, as a single parsed hand. */
function fixture(prefix: string): PhfHand {
  const file = files.find((entry) => entry.name.startsWith(prefix));
  if (!file) {
    throw new Error(`fixture ${prefix} is missing from fixtures/samples/coinpoker/`);
  }
  const result = parseOrSkip(coinpokerParser.splitHands(file.text)[0]);
  if ("skipped" in result) {
    throw new Error(`fixture ${prefix} was skipped as ${result.skipped}`);
  }
  return result;
}

describe("coinpoker corpus", () => {
  it("has the 16 real fixtures the research pass shipped", () => {
    expect(files).toHaveLength(16);
    // 22 hands across 16 files: 01 and 16 hold four each, the rest one.
    expect(chunks).toHaveLength(22);
  });

  it("splits on the header, because one blank line separates hands", () => {
    // A splitter tuned to PokerStars' two blank lines reads the whole of
    // fixture 01 as a single hand.
    const multi = files.find((entry) => entry.name.startsWith("01"))!;
    expect(multi.text).not.toContain("\n\n\n");
    expect(coinpokerParser.splitHands(multi.text)).toHaveLength(4);
  });

  it.each(parsed.map((entry, i) => [`${entry.file} #${i}`, entry] as const))(
    "%s parses with no unknown lines",
    (_name, entry) => {
      if ("skipped" in entry.result) {
        // A refusal is a result, but it has to be a machine-readable one.
        expect(entry.result.skipped).toMatch(/^[a-z-]+$/);
        return;
      }
      expect(blindSpots(entry.result)).toEqual([]);
    },
  );

  it.each(hands.map((hand) => [hand.meta.handId, hand] as const))(
    "hand %s holds the chip invariants",
    (_id, hand) => {
      expect([
        ...chipConservation(hand),
        ...noNegativeStacks(hand),
        ...potFullyAwarded(hand),
        ...uncalledWithinCommitment(hand),
        ...seatsAndCards(hand),
      ]).toEqual([]);
    },
  );

  it.each(hands.map((hand) => [hand.meta.handId, hand] as const))(
    "hand %s validates with zero errors",
    (_id, hand) => {
      const report = validateHand(hand);
      expect(report.errors).toEqual([]);
      expect(report.ok).toBe(true);
    },
  );

  it.each(hands.map((hand) => [hand.meta.handId, hand] as const))(
    "hand %s survives a round trip through standard text",
    (_id, hand) => {
      expect(roundTripsThroughStandardText(hand)).toEqual([]);
    },
  );

  it("converts every hand it does not deliberately refuse", async () => {
    let converted = 0;
    let refused = 0;
    for (const file of files) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      converted += result.stats.converted;
      refused += result.stats.failed;
      // Nothing may fail for a reason other than the one cancelled hand: a
      // validator error here would mean the parser produced a wrong hand.
      expect(result.failures.map((failure) => failure.reason)).toEqual(
        result.failures.map(() => "hand-cancelled"),
      );
      expect(result.hands.every((hand) => hand.meta.siteId === SITE)).toBe(true);
    }
    // 22 hands in, 21 converted, and the only refusal is the cancelled one.
    expect(converted).toBe(21);
    expect(refused).toBe(1);
  });
});

describe("coinpoker detection", () => {
  it.each(files.map((file) => [file.relativePath, file] as const))(
    "%s ranks CoinPoker first",
    (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe(SITE);
      expect(ranked[0]?.confidence).toBe(0.95);
    },
  );

  it("scores 0 on every other site's fixtures", () => {
    // Detection scoring is a shared namespace: a parser claiming somebody
    // else's corpus is worse than one that fails to claim its own, because the
    // hand is then silently converted by the wrong grammar.
    const others = [
      "888poker",
      "bossmedia",
      "entraction",
      "ggpoker",
      "ipoker",
      "merge",
      "microgaming",
      "ongame",
      "partypoker",
      "pokerbros",
      "pokerstars",
      "unibet",
      "weplay",
      "winamax",
      "wpt-global",
    ];
    for (const site of others) {
      for (const file of sampleFiles(site)) {
        expect(`${site}/${file.name}: ${coinpokerParser.detect(file.text)}`).toBe(
          `${site}/${file.name}: 0`,
        );
      }
    }
  });

  it("does not claim the PokerStars grammar it is descended from", () => {
    // The body of a CoinPoker hand reads as PokerStars, so the boundary is the
    // header and nothing else. Checked in both directions.
    const stars = [
      "PokerStars Hand #123456789:  Hold'em No Limit ($0.01/$0.02 USD) - 2021/01/01 1:00:00 ET",
      "Table 'Test' 6-max Seat #1 is the button",
      "Seat 1: alice ($2 in chips)",
    ].join("\n");
    expect(coinpokerParser.detect(stars)).toBe(0);
    expect(detectSite(stars)[0]?.parser.id).toBe("pokerstars");

    const coin = files[0].text;
    const pokerstars = getParsers().find((parser) => parser.id === "pokerstars")!;
    expect(pokerstars.detect(coin)).toBe(0);
    expect(coinpokerParser.detect(coin)).toBe(0.95);
  });

  it("claims a header-less CoinPoker paste only weakly", () => {
    expect(coinpokerParser.detect("exported from CoinPoker")).toBe(0.3);
    expect(coinpokerParser.detect("Seat 1: alice (2.00 in chips)")).toBe(0);
    // The corroborating signals on their own belong to nobody.
    expect(coinpokerParser.detect("Game ended: 2025/06/19 18:53:39 GMT")).toBe(0);
  });
});

describe("coinpoker money", () => {
  it("denominates cash hands in USDT at one hundred minor units", () => {
    const hand = fixture("02");
    expect(hand.game.unit).toEqual({
      code: "USDT",
      symbol: "$",
      minorUnits: 100,
      kind: "cash",
    });
    // Two decimals, exactly: 0.01/0.02 is one and two minor units, not one and
    // two chips, and not a hundred and two hundred.
    expect(hand.game.smallBlind).toBe(1);
    expect(hand.game.bigBlind).toBe(2);
    expect(hand.players.find((p) => p.name === "cp17par")?.startingStack).toBe(224);
    expect(hand.results.totalPot).toBe(11);
    expect(hand.results.fees.rake).toBe(1);
  });

  it("every printed amount in the corpus fits two decimal places", () => {
    // The guard the whole parser exists to protect: CoinPoker prints bare
    // decimals with no symbol, so a permissive money regex would match a
    // thousandth-denominated hand, balance it against its own pot and validate
    // it while every amount was wrong by a factor of ten.
    for (const file of files) {
      const body = file.text
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("CoinPoker Hand #"));
      expect(`${file.name}: ${body.filter((line) => /\d+\.\d{3,}/.test(line)).length}`).toBe(
        `${file.name}: 0`,
      );
    }
  });

  it("refuses a hand it cannot hold exactly rather than rounding it", () => {
    const over = files
      .find((file) => file.name.startsWith("02"))!
      .text.replace("posts small blind 0.01", "posts small blind 0.015");
    expect(() =>
      coinpokerParser.parseHand(coinpokerParser.splitHands(over)[0], {
        sourceFilename: null,
        options: {},
      }),
    ).toThrow(/unsupported-precision|more precision/);
    try {
      coinpokerParser.parseHand(coinpokerParser.splitHands(over)[0], {
        sourceFilename: null,
        options: {},
      });
    } catch (error) {
      expect((error as ParseSkip).reason).toBe("unsupported-precision");
    }
  });

  it("keeps tournament stacks in chips and refuses a fractional one", () => {
    const hand = fixture("12");
    expect(hand.game.unit.minorUnits).toBe(1);
    expect(hand.players.find((p) => p.name === "nlin")?.startingStack).toBe(5000);
    expect(hand.game.bigBlind).toBe(100);
    expect(toBigBlinds(5000, hand.game.bigBlind)).toBe(50);

    const fractional = files
      .find((file) => file.name.startsWith("12"))!
      .text.replace("posts the ante 13", "posts the ante 13.5");
    try {
      coinpokerParser.parseHand(coinpokerParser.splitHands(fractional)[0], {
        sourceFilename: null,
        options: {},
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as ParseSkip).reason).toBe("unsupported-precision");
    }
  });

  it("does not read the tournament name's amounts as a buy-in", () => {
    // `₮0.10 Mega Sat to ₮1 Mini Dojo PKO` names two amounts and neither is the
    // entry fee. CoinPoker's header states no buy-in at all.
    const hand = fixture("13");
    expect(hand.tournament?.name).toBe("₮0.10 Mega Sat to ₮1 Mini Dojo PKO, 15 Seats GTD");
    expect(hand.tournament?.buyIn).toBe(0);
    expect(hand.tournament?.fee).toBe(0);
    expect(hand.meta.warnings.map((warning) => warning.code)).toContain("buy-in-not-stated");
    // A freeroll's zero buy-in is the truth, so it carries no flag.
    expect(fixture("12").meta.warnings).toEqual([]);
  });
});

describe("coinpoker line grammar", () => {
  it("reads an all-in raise that has no `to` as chips added (fixture 05)", () => {
    const hand = fixture("05");
    const raise = hand.actions.find(
      (action) => action.player === "waqqas" && action.type === "raise",
    )!;
    expect(raise.rawLine).toBe("waqqas: raises 0.46 and is all-in");
    expect(raise.allIn).toBe(true);
    // 0.46 is the chips added, and waqqas had nothing in on the flop, so the
    // street total is 0.46 - which is exactly the stack left after 0.18
    // preflop out of 0.64.
    expect(raise.amount).toBe(46);
    expect(raise.streetTotal).toBe(46);
    expect(hand.results.players.find((p) => p.player === "waqqas")?.contributed).toBe(64);
    // The normal form is in the same hand and still works.
    const normal = hand.actions.find(
      (action) => action.player === "StoicMind" && action.type === "raise",
    )!;
    expect(normal.rawLine).toBe("StoicMind: raises 0.16 to 0.18");
    expect(normal.streetTotal).toBe(18);
  });

  it("adds an all-in raise to what the player already had in (fixture 01)", () => {
    // IFriendsY is in for 0.05 and writes `raises 2.00 and is all-in` out of a
    // 2.05 stack: reading 2.00 as a "to" would lose five cents of the pot.
    const hand = hands.find((entry) => entry.meta.handId === "352695201")!;
    // IFriendsY raises twice; the all-in is the second one.
    const raise = hand.actions.filter(
      (action) => action.player === "IFriendsY" && action.type === "raise",
    )[1];
    expect(raise.rawLine).toBe("IFriendsY: raises 2.00 and is all-in");
    expect(raise.streetTotal).toBe(205);
    expect(raise.amount).toBe(200);
    expect(hand.results.totalPot).toBe(416);
  });

  it("keeps the seat-line suffixes after the closing paren (fixture 10)", () => {
    const hand = fixture("10");
    expect(hand.players).toHaveLength(7);
    expect(hand.players.find((p) => p.name === "BehiAce")?.sittingOut).toBe(true);
    expect(hand.players.find((p) => p.name === "KERK3K")?.sittingOut).toBe(true);
    expect(hand.players.find((p) => p.name === "waqqas")?.sittingOut).toBe(false);
  });

  it("treats a dead small blind as dead money (fixture 10)", () => {
    const hand = fixture("10");
    const dead = hand.actions.find((action) => action.type === "missed-blind")!;
    expect(dead.rawLine).toBe("waqqas: posts small blind (dead) 0.01");
    // Dead money goes straight to the pot, so the later `calls 0.06` is a full
    // call rather than a completion: street total 0.06, contribution 0.07.
    expect(dead.streetTotal).toBe(0);
    const call = hand.actions.find(
      (action) => action.player === "waqqas" && action.type === "call",
    )!;
    expect(call.streetTotal).toBe(6);
    expect(hand.results.players.find((p) => p.player === "waqqas")?.contributed).toBe(7);
  });

  it("reads a second live big blind without moving the ring (fixtures 06, 11)", () => {
    const hand = fixture("06");
    const posts = hand.actions.filter((action) => action.type === "big-blind");
    expect(posts.map((action) => action.player)).toEqual(["waqqas", "HornyMelon"]);
    // The first posting is the blind; the second player checks behind theirs.
    expect(hand.players.find((p) => p.name === "waqqas")?.position).toBe("BB");
    expect(hand.players.find((p) => p.name === "HornyMelon")?.position).toBe("HJ");
    expect(posts[1].streetTotal).toBe(2);
  });

  it("tags the straddler and still classifies their summary line (fixture 04)", () => {
    const hand = fixture("04");
    expect(hand.game.straddles).toEqual([
      { seat: 3, player: "donkme123", amount: 4, order: 1 },
    ]);
    const straddler = hand.results.players.find((p) => p.player === "donkme123")!;
    expect(straddler.positionLabels).toEqual(["(straddle)"]);
    // CoinPoker never writes "and lost": the loser's summary line is bare, so a
    // parser that looks for the clause finds nobody at showdown.
    expect(straddler.outcome).toBe("lost");
    expect(straddler.shownCards).toEqual(["3h", "Ts"]);
    // The straddle is UTG, not a blind, so the ring is unchanged.
    expect(hand.players.find((p) => p.name === "donkme123")?.position).toBe("UTG");
  });

  it("keeps CoinPoker's own hand-description wording (fixtures 08, 09)", () => {
    // `three of kind` with no "a", and `Aces over Fours` where PokerStars says
    // "full of". A lookup table built from PokerStars wording misses both.
    const trips = fixture("08");
    expect(
      trips.results.players.find((p) => p.player === "crabcruncher")?.handDescription,
    ).toBe("three of kind, Queens");
    const boat = fixture("09");
    expect(boat.results.players.find((p) => p.player === "2waHang")?.handDescription).toBe(
      "a full house, Sevens over Nines",
    );
    expect(boat.actions.find((a) => a.type === "show" && a.player === "nlin")?.description).toBe(
      "a full house, Sevens over Eights",
    );
  });

  it("reads the space-padded summary board and the empty one (fixtures 01, 07)", () => {
    const walk = fixture("07");
    expect(walk.board.runouts[0].summaryCards).toEqual([]);
    expect(walk.results.streetReached).toBe("preflop");
    const turn = coinpokerParser.parseHand(
      coinpokerParser.splitHands(files.find((f) => f.name.startsWith("01"))!.text)[0],
      { sourceFilename: null, options: {} },
    );
    // `Board [ Jd 6c 5h 5c ]` is padded while `*** FLOP *** [Jd 6c 5h]` is not.
    expect(turn.board.runouts[0].summaryCards).toEqual(["Jd", "6c", "5h", "5c"]);
    expect(turn.board.runouts[0].flop).toEqual(["Jd", "6c", "5h"]);
    expect(turn.board.runouts[0].turn).toBe("5c");
  });

  it("pays a side pot CoinPoker spells with a hyphen (fixture 14)", () => {
    // `collected 52 from side-pot 1`. A corpus grep for "side pot" reports that
    // CoinPoker has none, which is how the research doc's negative finding got
    // there; the hyphen is the whole difference.
    const hand = fixture("14");
    expect(hand.results.winners).toEqual([
      { player: "Alena160520", seat: 5, amount: 52, runoutIndex: 0 },
      { player: "LegendaryHacker", seat: 7, amount: 7611, runoutIndex: 0 },
    ]);
    expect(
      hand.actions.filter((a) => a.type === "collect").map((a) => a.potName),
    ).toEqual(["side-pot 1", "pot"]);
    expect(hand.results.totalPot).toBe(7663);
  });

  it("balances an all-in raise that was never returned (fixture 13)", () => {
    // CoinPoker prints no `Uncalled bet` line when the last aggressor was
    // all-in and everyone folded. The reported pot includes the overbet and the
    // winner collects all of it, so the hand is self-consistent and no return
    // may be invented.
    const hand = fixture("13");
    expect(hand.actions.some((action) => action.type === "uncalled")).toBe(false);
    expect(hand.results.totalPot).toBe(5715);
    const winner = hand.results.players.find((p) => p.player === "rmanamiri")!;
    expect(winner.contributed).toBe(5000);
    expect(winner.won).toBe(5715);
    expect(winner.net).toBe(715);
  });

  it("drops the time-bank and disconnect vocabulary (fixtures 06, 16)", () => {
    for (const prefix of ["06", "16"]) {
      const file = files.find((entry) => entry.name.startsWith(prefix))!;
      expect(file.text).toMatch(/activated time-bank \(\d+ seconds\)/);
      for (const chunk of coinpokerParser.splitHands(file.text)) {
        const hand = coinpokerParser.parseHand(chunk, { sourceFilename: null, options: {} });
        expect(hand.meta.warnings).toEqual([]);
        expect(hand.actions.some((action) => /time-bank|disconnect/.test(action.rawLine))).toBe(
          false,
        );
      }
    }
  });

  it("drops `didn't post big blind`, which is not a bet (fixture 07)", () => {
    const hand = fixture("07");
    expect(hand.actions.some((action) => action.player === "pddro11")).toBe(false);
    // pddro11 was not dealt in, so they get no position rather than a
    // plausible-looking wrong one.
    expect(hand.players.find((p) => p.name === "pddro11")?.position).toBeNull();
    expect(hand.results.totalPot).toBe(3);
  });

  it("refuses a cancelled hand rather than reporting a seven-way split", () => {
    const file = files.find((entry) => entry.name.startsWith("15"))!;
    const result = parseOrSkip(coinpokerParser.splitHands(file.text)[0]);
    expect(result).toEqual({ skipped: "hand-cancelled" });
  });

  it("refuses a variant it has not been written for", () => {
    const omaha = files
      .find((file) => file.name.startsWith("02"))!
      .text.replace("Hold'em No Limit", "Omaha Pot Limit");
    const result = parseOrSkip(coinpokerParser.splitHands(omaha)[0]);
    expect(result).toEqual({ skipped: "unsupported-variant" });
  });

  it("refuses a tournament in cash-only mode", () => {
    const file = files.find((entry) => entry.name.startsWith("12"))!;
    expect(() =>
      coinpokerParser.parseHand(coinpokerParser.splitHands(file.text)[0], {
        sourceFilename: null,
        options: { cashOnly: true },
      }),
    ).toThrow(ParseSkip);
  });
});

describe("coinpoker positions", () => {
  it.each(hands.map((hand) => [hand.meta.handId, hand] as const))(
    "hand %s agrees with its own SUMMARY position words",
    (_id, hand) => {
      const acted = new Set(hand.actions.map((action) => action.seat));
      for (const result of hand.results.players) {
        const player = hand.players.find((entry) => entry.seat === result.seat)!;
        for (const label of result.positionLabels) {
          if (label === "(small blind)") {
            expect(`${result.player}: ${player.position}`).toBe(`${result.player}: SB`);
          }
          if (label === "(big blind)") {
            expect(`${result.player}: ${player.position}`).toBe(`${result.player}: BB`);
          }
          // The button word is only checked when that seat was dealt in.
          // Fixture 14 labels a seat marked `out of hand` as the button and
          // fixture 13 puts it on an empty seat: with a dead button the ring is
          // anchored on the blinds and the last live seat is the real BTN.
          if (label === "(button)" && acted.has(result.seat)) {
            expect(`${result.player}: ${player.position}`).toBe(`${result.player}: BTN`);
          }
        }
      }
    },
  );

  it("moves the button to the last live seat when it is dead (fixture 14)", () => {
    const hand = fixture("14");
    expect(hand.table.buttonSeat).toBe(2);
    // Seat 2 is `out of hand` and never acts, so it gets no position at all.
    expect(hand.players.find((p) => p.seat === 2)?.position).toBeNull();
    expect(hand.players.find((p) => p.seat === 1)?.position).toBe("BTN");
  });
});

describe("coinpoker provenance", () => {
  it.each(hands.map((hand) => [hand.meta.handId, hand] as const))(
    "hand %s carries the site's own text and a stable key",
    (_id, hand) => {
      expect(hand.meta.siteId).toBe(SITE);
      expect(hand.meta.siteName).toBe("CoinPoker");
      expect(hand.meta.parserId).toBe(SITE);
      expect(hand.meta.parserVersion).toBe(coinpokerParser.version);
      expect(hand.meta.handKey).toBe(`CP${hand.meta.handId}`);
      // The raw text is CoinPoker's, not our rewrite of it, so a later fix can
      // re-convert from the source.
      expect(hand.meta.rawText.startsWith(`CoinPoker Hand #${hand.meta.handId}:`)).toBe(true);
      expect(hand.playedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
      expect(hand.table.maxSeats).toBe(7);
    },
  );

  it("re-generates the summary seat lines so every amount keeps its symbol", () => {
    // CoinPoker's own prose writes `and won (0.20)` with no currency symbol.
    // Replaying it verbatim would drop the symbol from the one place a tracker
    // reads a per-seat amount, so the structured fields drive the line instead.
    for (const hand of hands) {
      for (const result of hand.results.players) {
        expect(result.outcome).not.toBe("unknown");
        expect(result.raw).toBeNull();
      }
    }
    const text = toStandardText(fixture("04"));
    expect(text).toContain("Seat 3: donkme123 (straddle) showed [3h Ts] and lost");
    expect(text).toContain(
      "Seat 7: NorthKing (button) showed [Ad 9h] and won ($0.20) with a pair of Nines",
    );
    // Chip amounts stay bare, because the tournament unit has no symbol.
    expect(toStandardText(fixture("13"))).toContain(
      "Seat 4: rmanamiri (big blind) collected (5715)",
    );
  });

  it("identifies the hero from the deal line, since there is no Hero literal", () => {
    // CoinPoker does not anonymise: the observer is `nlin` throughout.
    for (const hand of hands) {
      expect(hand.players.filter((player) => player.isHero)).toHaveLength(1);
      expect(hand.players.find((player) => player.isHero)?.name).toBe("nlin");
      expect(hand.results.heroNet).not.toBeNull();
    }
  });
});
