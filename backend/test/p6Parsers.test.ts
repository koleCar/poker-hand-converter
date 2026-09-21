/**
 * Winamax and the Chico network, over their whole fixture corpora.
 *
 * Table driven over the directories rather than over cherry-picked hands: the
 * point of a corpus is to catch the line shape nobody thought of, and that only
 * happens if every file runs every time.
 *
 * Two things are deliberately stricter than the other suites:
 *
 * - **Site membership is decided from the text, not the folder.** The Winamax
 *   directory contains one file whose name claims a game type its bytes do not
 *   have, and the upstream corpora have filed hands under the wrong room before.
 * - **Chico is reported per skin.** It is one network with four confirmed
 *   dialects, and an aggregate pass rate would hide a skin failing wholesale.
 */

import { describe, expect, it } from "vitest";

import { chicoParser, convertAny, detectSite, winamaxParser } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  contributionsFromActions,
  totalFees,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import {
  CHICO_CONFIRMED_SKINS,
  CHICO_INFERRED_SKINS,
  chicoSkinOf,
  isWinamaxText,
  otherSampleSites,
  sampleFiles,
  type P6File,
} from "./support/p6Corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

const MINE = [winamaxParser.id, chicoParser.id];

/**
 * Reasons these two parsers are allowed to refuse a hand with.
 *
 * Deliberately closed: a refusal with an unexplained reason is a silent failure
 * too. Every entry here is exercised by at least one real fixture.
 */
const ALLOWED_REASONS = new Set([
  // Round one is Hold'em. One whole Chico file is Omaha behind a Hold'em label.
  "unsupported-variant",
  // No verified Winamax tournament sample exists anywhere.
  "unsupported-tournament",
  // Windows-1252 euro signs read as UTF-8; the currency cannot be identified.
  "unsupported-encoding",
  // An amount outside the one decimal shape the corpus proves.
  "unsupported-locale",
  // Source text that contradicts itself or stops early.
  "board-mismatch",
  "truncated-hand",
  "rake-mismatch",
  "payout-mismatch",
  "uncalled-mismatch",
  "inconsistent-pot",
  "no-winner",
  "unseated-actor",
  "unnamed-seat",
  "duplicate-seat",
  "duplicate-player",
  "duplicate-card",
  "fractional-chips",
  "board-size",
  "too-few-players",
  // A seat listed with a 0.00 stack that then bets; caught by the validator.
  "negative-stack",
  // The deliberately corrupted Winamax negative fixture, which no parser claims.
  "unknown-site",
]);

/**
 * Warning codes these parsers may attach to a hand they did convert.
 *
 * `unknown-line` and `unknown-summary-line` are deliberately absent: an
 * unrecognised source line has to fail the build rather than the user, which is
 * what makes an empty-by-default warning list proof of full line coverage.
 */
const ALLOWED_WARNINGS = new Set([
  "board-from-summary",
  "assumed-currency",
  "unreadable-shown-cards",
  "unverified-skin",
  "play-money-table",
  "unreadable-timestamp",
]);

/** The projection two semantically equal hands must agree on. */
function semantics(hand: PhfHand) {
  return {
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    game: hand.game,
    table: hand.table,
    players: hand.players,
    board: hand.board,
    results: hand.results,
    textStyle: hand.meta.textStyle,
    actions: hand.actions.map((action) => ({
      street: action.street,
      player: action.player,
      type: action.type,
      amount: action.amount,
      streetTotal: action.streetTotal,
      allIn: action.allIn,
      cards: action.cards ?? null,
      potName: action.potName ?? null,
    })),
  };
}

/** Every invariant a converted hand has to satisfy, whichever room it came from. */
function assertSoundHand(hand: PhfHand, where: string): void {
  for (const warning of hand.meta.warnings) {
    expect(ALLOWED_WARNINGS, `${where}: ${warning.code} - ${warning.message}`).toContain(
      warning.code,
    );
  }
  expect(validateHand(hand).errors, where).toEqual([]);
  expect(hand.meta.rawText.length, where).toBeGreaterThan(0);
  expect(hand.game.variant, where).toBe("holdem");
  expect(hand.meta.handKey, where).toBe(hand.meta.handId);

  const contributed = [...contributionsFromActions(hand).values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  expect(contributed, `${where} chips in`).toBe(hand.results.totalPot);

  const paid = hand.results.winners.reduce((sum, winner) => sum + winner.amount, 0);
  // Both rooms report a pot the rake has already come out of, so the two have to
  // add back up to the stated total exactly.
  expect(paid + totalFees(hand.results.fees), `${where} chips out`).toBe(hand.results.totalPot);
  expect(hand.results.fees.rake, `${where} rake`).toBeGreaterThanOrEqual(0);

  const stacks = new Map(hand.players.map((player) => [player.name, player.startingStack]));
  for (const action of hand.actions) {
    if (action.type === "collect" || action.amount === 0) {
      continue;
    }
    const next = (stacks.get(action.player) ?? 0) - action.amount;
    stacks.set(action.player, next);
    expect(next, `${where} ${action.player} after "${action.rawLine}"`).toBeGreaterThanOrEqual(0);
  }
}

function assertRoundTrips(hand: PhfHand): void {
  const text = toStandardText(hand);
  const reparsed = parseStandardHand(text, CTX);
  expect(reparsed, text.split("\n")[0]).not.toBeNull();
  expect(reparsed!.meta.warnings, text.split("\n")[0]).toEqual([]);
  expect(toStandardText(reparsed!)).toBe(text);
  expect(semantics(reparsed!), hand.meta.handId).toEqual(semantics(hand));
}

function assertReplays(hand: PhfHand): void {
  const frames = buildReplay(hand);
  expect(frames.length, hand.meta.handId).toBeGreaterThan(0);
  for (const frame of frames) {
    for (const seat of frame.seats) {
      expect(seat.stack, `${hand.meta.handId} ${seat.name}`).toBeGreaterThan(-0.005);
    }
  }
  if (hand.results.winners.length > 0) {
    const final = frames[frames.length - 1];
    expect(final.kind, hand.meta.handId).toBe("award");
    expect(final.pot, hand.meta.handId).toBe(0);
  }
}

/* ----------------------------------------------------------------- Winamax - */

const WINAMAX_FILES = sampleFiles("winamax");
/**
 * The upstream corpus's own deliberately corrupted negative fixture: the site
 * name is misspelled `Winaax Poker`, the blind marker has lost its slash and the
 * summary marker is truncated to bare `***`. It exists to prove a parser rejects
 * garbage, so it is held to the opposite assertion from every other file.
 */
const WINAMAX_NEGATIVE = "CashGame_ValidHandTests_InValidHand.txt";

describe("Winamax corpus", () => {
  const files = WINAMAX_FILES.map((file) => [file.relativePath, file] as const);

  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s is Winamax text and is attributed to Winamax", (_name, file) => {
    if (file.name === WINAMAX_NEGATIVE) {
      // Nothing should claim it, least of all us.
      expect(isWinamaxText(file.text)).toBe(false);
      expect(detectSite(file.text)).toEqual([]);
      return;
    }
    expect(isWinamaxText(file.text)).toBe(true);
    const ranked = detectSite(file.text);
    expect(ranked[0]?.parser.id).toBe("winamax");
    expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each(files)("%s converts or refuses with a reason", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    expect(result.stats.total).toBeGreaterThan(0);
    expect(result.stats.total).toBe(result.stats.converted + result.stats.failed);

    for (const failure of result.failures) {
      expect(ALLOWED_REASONS, `${failure.reason}: ${failure.message}`).toContain(failure.reason);
      expect(failure.message.length).toBeGreaterThan(10);
    }
    for (const hand of result.hands) {
      expect(hand.meta.siteId).toBe("winamax");
      expect(hand.meta.handId.startsWith("WMX-"), hand.meta.handId).toBe(true);
      expect(hand.game.format).toBe("cash");
      assertSoundHand(hand, `${file.name} ${hand.meta.handId}`);
    }
  });

  it.each(files)("%s round-trips and replays", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    for (const hand of result.hands) {
      assertRoundTrips(hand);
      assertReplays(hand);
    }
  });

  it("converts every hand the corpus can prove, and states why it refuses the rest", async () => {
    const reasons: Record<string, number> = {};
    let converted = 0;
    for (const file of WINAMAX_FILES) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      converted += result.hands.length;
      for (const failure of result.failures) {
        reasons[failure.reason] = (reasons[failure.reason] ?? 0) + 1;
      }
    }
    // 30 hands across 21 files (one holds ten), plus six refusals that are each
    // a documented property of the source rather than a gap in the parser.
    expect(converted).toBe(30);
    expect(reasons).toEqual({
      // Three files carry a Windows-1252 euro sign; read as UTF-8 the currency
      // is unidentifiable, and one of the three is Omaha anyway.
      "unsupported-encoding": 3,
      // `CashGame_PlayerTests_OmahaShowdown.txt`.
      "unsupported-variant": 1,
      // `CashGame_StreetTests_Flop.txt` deals [3d 3s 2s] and summarises
      // [7h Qs 3c]; neither board can be trusted.
      "board-mismatch": 1,
      // The upstream negative fixture, which no parser claims.
      "unknown-site": 1,
    });
  });
});

describe("Winamax refusals", () => {
  const header = [
    "Winamax Poker - CashGame - HandId: #1-2-3 - Holdem no limit (0.25€/0.50€) - 2013/11/07 03:53:58 UTC",
    "Table: 'Milwaukee 02' 5-max (real money) Seat #2 is the button",
    "Seat 1: alice (99.36€)",
    "Seat 2: bob (64.76€)",
    "*** ANTE/BLINDS ***",
    "alice posts small blind 0.25€",
    "bob posts big blind 0.50€",
    "*** PRE-FLOP *** ",
    "alice folds",
    "bob collected 0.75€ from pot",
    "*** SUMMARY ***",
    "Total pot 0.75€ | No rake",
  ].join("\n");

  async function reasonFor(text: string): Promise<string | undefined> {
    const result = await convertAny(text, { siteId: "winamax" });
    return result.failures[0]?.reason;
  }

  it("accepts the baseline hand the other cases are derived from", async () => {
    const result = await convertAny(header, { siteId: "winamax" });
    expect(result.failures).toEqual([]);
    expect(result.hands[0].game.unit.code).toBe("EUR");
  });

  it("refuses a comma decimal rather than reading it as a hundred times more", async () => {
    // `parseAmount` strips every non-digit, so `1 234,50€` would come back as
    // 123450 cents and the hand would balance perfectly against itself.
    expect(await reasonFor(header.replace("0.25€", "0,25€"))).toBe("unsupported-locale");
    expect(await reasonFor(header.replace("64.76€", "1 234,50€"))).toBe("unsupported-locale");
  });

  it("refuses a file decoded with the wrong codec", async () => {
    expect(await reasonFor(header.replaceAll("€", "�"))).toBe("unsupported-encoding");
  });

  it("refuses a currency it cannot name", async () => {
    expect(await reasonFor(header.replaceAll("€", " kr"))).toBe("unsupported-currency");
  });

  it("refuses tournaments, which no verified sample exists for", async () => {
    const tournament = header.replace(
      "Winamax Poker - CashGame - HandId:",
      'Winamax Poker - Tournament "PPT Freeroll" buyIn: Free level: 0 - HandId:',
    );
    expect(await reasonFor(tournament)).toBe("unsupported-tournament");
  });
});

/* ------------------------------------------------------------------- Chico - */

const CHICO_FILES = sampleFiles("chico");

function chicoFilesForSkin(skin: string): P6File[] {
  return CHICO_FILES.filter((file) => chicoSkinOf(file.text) === skin);
}

describe("Chico corpus", () => {
  const files = CHICO_FILES.map((file) => [file.relativePath, file] as const);

  it("finds the corpus", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("every file's bytes name a skin the parser knows", () => {
    for (const file of CHICO_FILES) {
      expect(chicoSkinOf(file.text), file.relativePath).not.toBeNull();
    }
  });

  it.each(files)("%s is attributed to the Chico parser", (_name, file) => {
    const ranked = detectSite(file.text);
    expect(ranked[0]?.parser.id).toBe("chico");
    expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it.each(files)("%s converts or refuses with a reason", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    expect(result.stats.total).toBeGreaterThan(0);
    expect(result.stats.total).toBe(result.stats.converted + result.stats.failed);

    for (const failure of result.failures) {
      expect(ALLOWED_REASONS, `${failure.reason}: ${failure.message}`).toContain(failure.reason);
      expect(failure.detectedSite).toBe("chico");
      expect(failure.message.length).toBeGreaterThan(10);
    }
    for (const hand of result.hands) {
      expect(hand.meta.siteId).toBe("chico");
      expect(hand.meta.handId.startsWith("CHC-"), hand.meta.handId).toBe(true);
      assertSoundHand(hand, `${file.name} ${hand.meta.handId}`);
    }
  });

  it.each(files)("%s round-trips and replays", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    for (const hand of result.hands) {
      assertRoundTrips(hand);
      assertReplays(hand);
    }
  });

  it("reads tournament stacks as chips and cash tables as money", async () => {
    for (const file of CHICO_FILES) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        if (hand.game.format === "tournament") {
          expect(hand.game.unit.kind, hand.meta.handId).toBe("chips");
          expect(hand.tournament?.id, hand.meta.handId).toMatch(/^\d+$/);
          // The network never prints a buy-in or a level number, so neither is
          // invented; the level blinds it does print are kept.
          expect(hand.tournament?.buyIn).toBe(0);
          expect(hand.tournament?.levelNumber).toBeNull();
          expect(hand.tournament?.levelBigBlind).toBeGreaterThan(0);
        } else {
          expect(hand.game.format, hand.meta.handId).toBe("cash");
        }
      }
    }
  });
});

/**
 * Per-skin pass rates.
 *
 * Reported separately on purpose: this is one network with four confirmed
 * dialects and an aggregate would let a skin fail wholesale behind BetOnline's
 * volume. The counts are pinned so that a regression in one skin cannot be
 * absorbed by an improvement in another.
 */
describe("Chico coverage per skin", () => {
  const expected: Record<string, { files: number; converted: number; refused: number }> = {
    // The bulk of the corpus: 13 files, 3 of them multi-hand.
    "BetOnline Poker": { files: 13, converted: 40, refused: 24 },
    "PayNoRake": { files: 1, converted: 1, refused: 0 },
    "ActionPoker.com": { files: 1, converted: 1, refused: 0 },
    "Gear Poker": { files: 1, converted: 2, refused: 0 },
  };

  it.each(CHICO_CONFIRMED_SKINS.map((skin) => [skin] as const))(
    "%s converts the hands its fixtures can prove",
    async (skin) => {
      const files = chicoFilesForSkin(skin);
      expect(files.length, `${skin} files`).toBe(expected[skin].files);

      let converted = 0;
      let refused = 0;
      for (const file of files) {
        const result = await convertAny(file.text, { sourceFilename: file.name });
        converted += result.hands.length;
        refused += result.failures.length;
        for (const hand of result.hands) {
          assertSoundHand(hand, `${skin} ${file.name} ${hand.meta.handId}`);
        }
      }
      expect(converted, `${skin} converted`).toBe(expected[skin].converted);
      expect(refused, `${skin} refused`).toBe(expected[skin].refused);
    },
  );

  it("has no fixture at all for the two inferred skins", () => {
    // If this ever fails somebody has landed a real TigerGaming or
    // SportsBetting.ag sample, and the parser's claims about them - and the
    // report that went with it - need re-checking against real bytes.
    for (const skin of CHICO_INFERRED_SKINS) {
      expect(chicoFilesForSkin(skin), skin).toEqual([]);
    }
  });

  it("flags a hand from an inferred skin instead of pretending it is verified", async () => {
    const betonline = chicoFilesForSkin("BetOnline Poker").find((file) =>
      file.name.includes("zero.ante"),
    )!;
    const tiger = betonline.text.replaceAll("BetOnline Poker Game #", "Tiger Gaming Game #");

    // Still the best candidate by a mile - nobody else emits the brand string -
    // but scored below the dialects that are backed by real bytes.
    const ranked = detectSite(tiger);
    expect(ranked[0]?.parser.id).toBe("chico");
    expect(ranked[0]?.confidence).toBeLessThan(0.9);

    const result = await convertAny(tiger, { sourceFilename: "tiger.txt" });
    expect(result.hands).toHaveLength(1);
    expect(result.hands[0].meta.warnings.map((warning) => warning.code)).toContain(
      "unverified-skin",
    );
  });

  it("does not name the unverified skins in the display name", () => {
    for (const skin of ["SportsBetting", "Tiger"]) {
      expect(chicoParser.name).not.toContain(skin);
    }
    for (const skin of ["BetOnline", "PayNoRake", "ActionPoker", "Gear Poker"]) {
      expect(chicoParser.name).toContain(skin);
    }
  });
});

describe("Chico dialect differences", () => {
  /** The four confirmed skins, and the one structural difference each brings. */
  it("reads the Title-Case skins' verbs, periods and capitalised chips", async () => {
    const actionPoker = chicoFilesForSkin("ActionPoker.com")[0];
    const result = await convertAny(actionPoker.text, { sourceFilename: actionPoker.name });
    const hand = result.hands[0];
    // `Posts small blind 1.00.` / `Calls 2.00.` / `Folds.` all parsed.
    expect(hand.actions.filter((action) => action.type === "fold")).not.toHaveLength(0);
    expect(hand.game.smallBlind).toBe(100);
    expect(hand.game.bigBlind).toBe(200);
    // `Seat 0: Player0 (79.50 in Chips)` - capital C.
    expect(hand.players.find((player) => player.seat === 0)?.startingStack).toBe(7950);
  });

  it("normalizes the network's `10` rank so the card is not silently dropped", async () => {
    const file = chicoFilesForSkin("BetOnline Poker").find((entry) =>
      entry.name.includes("post.dead"),
    )!;
    const result = await convertAny(file.text, { sourceFilename: file.name });
    // `*** TURN *** [6c 7s Qc][10d]` - both the run-together brackets and the
    // two-character ten have to survive.
    expect(result.hands[0].board.runouts[0].turn).toBe("Td");
  });

  it("takes the variant from the cards, not from the header label", async () => {
    // Every hand in this file is headed `Hold'em Pot Limit` and deals four cards.
    const plo = CHICO_FILES.find((file) => file.name.includes("PLO"))!;
    expect(plo.text).toContain("Hold'em Pot Limit");
    const result = await convertAny(plo.text, { sourceFilename: plo.name });
    expect(result.hands).toEqual([]);
    expect(new Set(result.failures.map((failure) => failure.reason))).toEqual(
      new Set(["unsupported-variant"]),
    );
  });

  it("refuses the two confirmed site-side data defects", async () => {
    const cases: Array<[string, string]> = [
      ["two.players.one.seat", "duplicate-seat"],
      ["dead.stack", "unnamed-seat"],
    ];
    for (const [fragment, reason] of cases) {
      const file = CHICO_FILES.find((entry) => entry.name.includes(fragment))!;
      const result = await convertAny(file.text, { sourceFilename: file.name });
      expect(result.hands, fragment).toEqual([]);
      expect(result.failures[0].reason, fragment).toBe(reason);
    }
  });
});

/* --------------------------------------------------------------- detection - */

describe("detection is a shared namespace", () => {
  const dirs = otherSampleSites(["winamax", "chico"]);

  it.each(dirs.map((name) => [name] as const))(
    "neither parser claims a %s sample",
    (dir) => {
      const claims: string[] = [];
      for (const file of sampleFiles(dir)) {
        for (const candidate of detectSite(file.text)) {
          if (MINE.includes(candidate.parser.id)) {
            claims.push(`${candidate.parser.id} claims ${file.relativePath}`);
          }
        }
      }
      expect(claims).toEqual([]);
    },
  );

  it("scores zero, not merely below threshold, on every other site's samples", () => {
    for (const dir of dirs) {
      for (const file of sampleFiles(dir)) {
        expect(winamaxParser.detect(file.text), `winamax vs ${file.relativePath}`).toBe(0);
        expect(chicoParser.detect(file.text), `chico vs ${file.relativePath}`).toBe(0);
      }
    }
  });

  it("no other parser claims a Winamax or Chico sample", () => {
    const claims: string[] = [];
    for (const file of [...WINAMAX_FILES, ...CHICO_FILES]) {
      if (file.name === WINAMAX_NEGATIVE) {
        continue;
      }
      const mine = isWinamaxText(file.text) ? "winamax" : "chico";
      for (const candidate of detectSite(file.text)) {
        if (candidate.parser.id !== mine) {
          claims.push(
            `${candidate.parser.id} (${candidate.confidence}) claims ${file.relativePath}`,
          );
        }
      }
    }
    expect(claims).toEqual([]);
  });

  it("does not claim PokerStars, GG or WPN-shaped text", () => {
    const foreign = [
      [
        "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
        "Table 'Aaltje II' 6-max Seat #2 is the button",
      ].join("\n"),
      [
        "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
        "Table 'NLHPurple70' 6-max Seat #1 is the button",
      ].join("\n"),
      // WPN era C: structurally close to Chico but with no brand name at all,
      // which is exactly the disambiguator the Chico parser keys off.
      ["Game Hand #1234567 - Hold'em No Limit ($0.01/$0.02)", "Table 'Bilbao' 6-max Seat #1"].join(
        "\n",
      ),
    ];
    for (const text of foreign) {
      expect(winamaxParser.detect(text)).toBe(0);
      expect(chicoParser.detect(text)).toBe(0);
    }
  });
});
