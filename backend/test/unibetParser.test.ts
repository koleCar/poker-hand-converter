/**
 * Unibet Poker, over the whole fixture corpus.
 *
 * Table driven over the directory rather than over cherry-picked hands, for the
 * same reason as the other suites: the point of a corpus is to catch the line
 * shape nobody thought of, and that only happens if every file runs every time.
 *
 * Three things are specific to this room and get their own sections below:
 *
 *  - **two header generations.** The 2021 `Game #...: Table €1 NL` shape and the
 *    2026 `Unibet Hand #...` shape are both live in the corpus, so both are
 *    asserted explicitly rather than left to the corpus sweep.
 *  - **two byte encodings.** The same hand exists upstream in Windows-1252 and
 *    in UTF-8. Decoded correctly the two must produce the *same* PHF; decoded
 *    wrongly the hand must be refused, not silently converted with a guessed
 *    currency.
 *  - **the iPoker boundary.** Unibet has run an iPoker skin, whose export is XML
 *    and belongs to `parsers/ipoker.ts`. Both directions are asserted.
 */

import { describe, expect, it } from "vitest";

import { convertAny, detectSite } from "../../frontend/src/lib/parsers/index.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import {
  contributionsFromActions,
  totalFees,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import {
  decodeCp1252,
  otherSampleSites,
  sampleFiles,
  type CorpusFile,
} from "./support/p4Corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

const FILES = sampleFiles("unibet");
const CASES = FILES.map((file) => [file.relativePath, file] as const);

/**
 * Reasons this parser is allowed to refuse a hand with.
 *
 * Deliberately closed: anything outside this list is either a bug or a decision
 * that has not been written down yet.
 */
const ALLOWED_REASONS = new Set([
  // Round one is Hold'em; the corpus carries two PLO hands.
  "unsupported-variant",
  // A Windows-1252 export read as UTF-8; the currency byte is gone for good.
  "lossy-encoding",
  // The separate tournament-summary export, which holds no hands.
  "tournament-summary",
  // Source text that never says who was given the pot.
  "no-winner",
  // Source text that contradicts itself.
  "inconsistent-pot",
  "board-size",
  "too-few-players",
  "no-players",
  "no-currency",
  "cashout",
]);

/**
 * Whether a file is Unibet text, decided from the text and never from the
 * directory it sits in.
 *
 * The p2 suite caught genuinely mislabelled upstream fixtures this way. The
 * signature is deliberately not the parser's own `detect`, so that a detector
 * bug cannot make this check pass.
 */
const UNIBET_DIALECT =
  /^(?:Unibet\s+(?:Hand|Tournament)\s+#|Game\s+#\d+:\s+Table\s+\S+\s+(?:PL|NL|FL)\s+-)/m;

/** The projection two semantically equal hands must agree on. */
function semantics(hand: PhfHand) {
  return {
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    game: hand.game,
    table: hand.table,
    // `levelLabel` / `levelNumber` are excluded on purpose. Unibet never prints
    // a tournament level, so the parser leaves both null, but the standard-text
    // grammar has no way to write "no level" - `toStandardText` emits `Level I`
    // and reading it back produces "I" / 1. The scaffolding is the serializer's,
    // not the room's, so the round trip is compared without it.
    tournament: hand.tournament
      ? { ...hand.tournament, levelLabel: null, levelNumber: null }
      : null,
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

function fileNamed(part: string): CorpusFile {
  const file = FILES.find((entry) => entry.name.includes(part));
  if (!file) {
    throw new Error(`No Unibet fixture matching "${part}"`);
  }
  return file;
}

describe("Unibet corpus", () => {
  it("finds the corpus", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(CASES)("%s is Unibet text, by its text and not its folder", (_name, file) => {
    expect(UNIBET_DIALECT.test(file.text), file.relativePath).toBe(true);
  });

  it.each(CASES)("%s is attributed to the Unibet parser", (_name, file) => {
    const ranked = detectSite(file.text);
    expect(ranked[0]?.parser.id, file.relativePath).toBe("unibet");
    expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    // Detection is a shared namespace: nobody else may even be a candidate.
    expect(ranked.map((candidate) => candidate.parser.id)).toEqual(["unibet"]);
  });

  it.each(CASES)("%s converts or refuses with a reason", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    expect(result.stats.total).toBeGreaterThan(0);
    expect(result.stats.total).toBe(result.stats.converted + result.stats.failed);

    for (const failure of result.failures) {
      expect(ALLOWED_REASONS, `${failure.reason}: ${failure.message}`).toContain(failure.reason);
      expect(failure.detectedSite).toBe("unibet");
      expect(failure.message.length).toBeGreaterThan(10);
      expect(failure.rawText.length).toBeGreaterThan(0);
    }

    for (const hand of result.hands) {
      const where = `${file.name} ${hand.meta.handId}`;
      // An unrecognised source line becomes a warning rather than a silent drop,
      // so an empty warning list is what proves full line coverage.
      expect(hand.meta.warnings, where).toEqual([]);
      expect(validateHand(hand).errors, where).toEqual([]);
      expect(hand.meta.siteId).toBe("unibet");
      expect(hand.meta.rawText.length).toBeGreaterThan(0);
      expect(hand.game.variant).toBe("holdem");
      // `meta.rawText` must be the room's text, not the normalized intermediate.
      expect(hand.meta.rawText).not.toContain("Poker Hand #");
      expect(hand.meta.handKey).toBe(hand.meta.handId);
      expect(hand.meta.handId.startsWith("UB-"), hand.meta.handId).toBe(true);
    }
  });

  it.each(CASES)("%s conserves chips in every hand", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    for (const hand of result.hands) {
      const where = `${file.name} ${hand.meta.handId}`;
      const contributed = [...contributionsFromActions(hand).values()].reduce(
        (sum, value) => sum + value,
        0,
      );
      expect(contributed, `${where} in`).toBe(hand.results.totalPot);

      const paid = hand.results.winners.reduce((sum, winner) => sum + winner.amount, 0);
      expect(paid + totalFees(hand.results.fees), `${where} out`).toBe(hand.results.totalPot);
      expect(hand.results.fees.rake, `${where} rake`).toBeGreaterThanOrEqual(0);

      const stacks = new Map(hand.players.map((player) => [player.name, player.startingStack]));
      for (const action of hand.actions) {
        if (action.type === "collect" || action.amount === 0) {
          continue;
        }
        const next = (stacks.get(action.player) ?? 0) - action.amount;
        stacks.set(action.player, next);
        expect(next, `${where} ${action.player} after "${action.rawLine}"`).toBeGreaterThanOrEqual(
          0,
        );
      }
    }
  });

  it.each(CASES)("%s round-trips through standard text", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    for (const hand of result.hands) {
      const text = toStandardText(hand);
      const reparsed = parseStandardHand(text, CTX)!;
      expect(reparsed, text.split("\n")[0]).not.toBeNull();
      expect(reparsed.meta.warnings, text.split("\n")[0]).toEqual([]);
      expect(toStandardText(reparsed)).toBe(text);
      expect(semantics(reparsed), hand.meta.handId).toEqual(semantics(hand));
    }
  });

  it.each(CASES)("%s replays without a negative stack", async (_name, file) => {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    for (const hand of result.hands) {
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
  });
});

describe("Unibet header generations", () => {
  it("reads the 2021 `Game #...: Table €1 NL` header", async () => {
    const file = fileNamed("02-cash-nlhe-banzai-2021-utf8");
    const { hands } = await convertAny(file.text, { sourceFilename: file.name });
    expect(hands).toHaveLength(1);
    const hand = hands[0];

    expect(hand.meta.handId).toBe("UB-1463192545");
    expect(hand.game.format).toBe("cash");
    expect(hand.game.unit.code).toBe("EUR");
    expect(hand.game.smallBlind).toBe(5);
    expect(hand.game.bigBlind).toBe(10);
    // The 2021 header has no table line at all, so the stakes token is the only
    // thing naming the table, and the seat count has to be inferred.
    expect(hand.table.name).toBe("€1 NL");
    expect(hand.table.maxSeats).toBe(6);
    expect(hand.table.buttonSeat).toBe(6);
    // No timezone token in this era; read as UTC.
    expect(hand.playedAt).toBe("2021-04-04T13:22:50.000Z");

    // `Hero raises €0.95 to €0.95` states a raise-by equal to the whole stack.
    // Only the "to" number is read, and the "by" is recomputed from the street.
    const raise = hand.actions.find((action) => action.type === "raise")!;
    expect(raise.streetTotal).toBe(95);
    expect(raise.allIn).toBe(true);

    // Unibet prints no `Uncalled bet` line here and counts the shove in its
    // stated `Total pot €1.10`. PHF's pot is the contested one.
    expect(hand.results.totalPot).toBe(25);
    const returned = hand.actions.find((action) => action.type === "uncalled")!;
    expect(returned.player).toBe("Hero");
    expect(returned.amount).toBe(-85);

    // The only seat with known cards is the owner of the export.
    expect(hand.players.find((player) => player.isHero)?.name).toBe("Hero");
    expect(hand.results.players.find((result) => result.player === "Hero")?.net).toBe(15);
  });

  it("reads the 2026 `Unibet Hand #...` header and its separate table line", async () => {
    const file = fileNamed("04-tournament-nlhe-2026");
    const { hands } = await convertAny(file.text, { sourceFilename: file.name });
    expect(hands).toHaveLength(1);
    const hand = hands[0];

    expect(hand.meta.handId).toBe("UB-1558006464");
    expect(hand.table.name).toBe("86116111");
    expect(hand.table.maxSeats).toBe(3);
    expect(hand.playedAt).toBe("2026-06-05T21:59:56.000Z");
    expect(hand.game.unit.code).toBe("CHIPS");
    expect(hand.game.format).toBe("tournament");

    expect(hand.tournament?.id).toBe("85614762");
    expect(hand.tournament?.buyIn).toBe(93);
    expect(hand.tournament?.fee).toBe(7);
    expect(hand.tournament?.buyInUnit.code).toBe("EUR");
    expect(hand.tournament?.levelSmallBlind).toBe(25);
    expect(hand.tournament?.levelBigBlind).toBe(50);
    // Unibet states no level, so nothing is invented for one.
    expect(hand.tournament?.levelLabel).toBeNull();
    expect(hand.tournament?.levelNumber).toBeNull();

    // The hero's session token is stripped so the same account is the same
    // player across files; the seat is still flagged as the hero.
    const hero = hand.players.find((player) => player.isHero)!;
    expect(hero.name).toBe("hero");
    expect(hand.meta.rawText).toContain("hero[Unibet_28204e083c0fb55a]");

    // The river marker repeats flop and turn in brackets of their own.
    expect(hand.board.runouts[0].flop).toEqual(["4s", "Tc", "8d"]);
    expect(hand.board.runouts[0].turn).toBe("Ac");
    expect(hand.board.runouts[0].river).toBe("9d");

    expect(hand.results.totalPot).toBe(300);
    expect(hand.results.wentToShowdown).toBe(true);
  });

  it("refuses the Omaha hands and the tournament-summary export by name", async () => {
    const plo = fileNamed("03-cash-plo-2026");
    const ploResult = await convertAny(plo.text, { sourceFilename: plo.name });
    expect(ploResult.hands).toHaveLength(0);
    expect(ploResult.failures.map((failure) => failure.reason)).toEqual([
      "unsupported-variant",
      "unsupported-variant",
    ]);

    const summary = fileNamed("05-tournament-summary");
    const summaryResult = await convertAny(summary.text, { sourceFilename: summary.name });
    expect(summaryResult.hands).toHaveLength(0);
    expect(summaryResult.failures.map((failure) => failure.reason)).toEqual([
      "tournament-summary",
    ]);
  });

  it("skips a tournament hand in cash-only mode", async () => {
    const file = fileNamed("04-tournament-nlhe-2026");
    const result = await convertAny(file.text, { sourceFilename: file.name, cashOnly: true });
    expect(result.hands).toHaveLength(0);
    expect(result.failures[0]?.reason).toBe("tournament-in-cash-mode");
  });
});

describe("Unibet encoding", () => {
  const cp1252 = fileNamed("01-cash-nlhe-banzai-2021-cp1252");
  const utf8 = fileNamed("02-cash-nlhe-banzai-2021-utf8");

  it("is the same hand in both byte encodings", () => {
    // The two fixtures exist to prove the ambiguity is real rather than
    // corruption: same game id, different bytes.
    expect(decodeCp1252(cp1252.bytes)).toContain("Game #1463192545");
    expect(utf8.text).toContain("Game #1463192545");
    expect(cp1252.bytes).not.toEqual(utf8.bytes);
  });

  it("produces identical PHF from Windows-1252 and UTF-8 once decoded correctly", async () => {
    const fromCp = await convertAny(decodeCp1252(cp1252.bytes), { sourceFilename: utf8.name });
    const fromU8 = await convertAny(utf8.text, { sourceFilename: utf8.name });
    expect(fromCp.hands).toHaveLength(1);
    expect(fromU8.hands).toHaveLength(1);
    expect(fromCp.hands[0].game.unit.code).toBe("EUR");
    expect(semantics(fromCp.hands[0])).toEqual(semantics(fromU8.hands[0]));
  });

  it("refuses a Windows-1252 export that was decoded as UTF-8", async () => {
    // This is what the app's upload path currently produces for fixture 01: the
    // `€` byte 0x80 becomes U+FFFD, and 0x80 (`€`) and 0xA3 (`£`) collapse onto
    // the same replacement character, so the currency cannot be recovered. The
    // amounts still parse and the hand would still balance, which is exactly why
    // it must not be converted.
    expect(cp1252.text).toContain("�");
    const result = await convertAny(cp1252.text, { sourceFilename: cp1252.name });
    expect(result.hands).toHaveLength(0);
    expect(result.failures[0]?.reason).toBe("lossy-encoding");
    expect(result.failures[0]?.message).toMatch(/Windows-1252/);
  });

  it("refuses a mojibake player name for the same reason", async () => {
    const mangled = utf8.text.replace("Player2", "Pl�yer2");
    const result = await convertAny(mangled, { sourceFilename: "mangled.txt" });
    expect(result.hands).toHaveLength(0);
    expect(result.failures[0]?.reason).toBe("lossy-encoding");
  });
});

describe("the Unibet / iPoker boundary", () => {
  // Unibet has run an iPoker skin (`UnibetIPoker`, site_id 87 upstream) whose
  // export is XML and has nothing in common with the plain text above. A file
  // has to land on the parser whose grammar it is actually written in, whatever
  // brand name it carries.
  const ipokerFixture = sampleFiles("ipoker").find((file) =>
    /Holdem\s+(?:NL|PL|L)\b/.test(file.text),
  )!;

  it("routes a Unibet-branded iPoker export to the iPoker parser", () => {
    const branded = ipokerFixture.text
      .replace(/<tablename>[^<]*<\/tablename>/, "<tablename>Unibet Poker, 51069081</tablename>")
      .replace(/<nickname>[^<]*<\/nickname>/, "<nickname>unibet_hero</nickname>");
    expect(branded).toContain("Unibet");

    const ranked = detectSite(branded);
    expect(ranked[0]?.parser.id).toBe("ipoker");
    expect(ranked.map((candidate) => candidate.parser.id)).not.toContain("unibet");
  });

  it("scores zero on every iPoker sample, branded or not", () => {
    for (const file of sampleFiles("ipoker")) {
      for (const candidate of detectSite(file.text)) {
        expect(candidate.parser.id, file.relativePath).not.toBe("unibet");
      }
    }
  });

  it("does not let the iPoker parser claim Unibet plain text", () => {
    for (const file of FILES) {
      for (const candidate of detectSite(file.text)) {
        expect(candidate.parser.id, file.relativePath).not.toBe("ipoker");
      }
    }
  });
});

describe("detection is a shared namespace", () => {
  it.each(otherSampleSites(["unibet"]).map((name) => [name] as const))(
    "the Unibet parser does not claim a %s sample",
    (dir) => {
      const claims: string[] = [];
      for (const file of sampleFiles(dir)) {
        for (const candidate of detectSite(file.text)) {
          if (candidate.parser.id === "unibet") {
            claims.push(`${file.relativePath} @ ${candidate.confidence}`);
          }
        }
      }
      expect(claims).toEqual([]);
    },
  );

  it("does not claim Entraction, which also opens every hand with `Game #`", () => {
    // Entraction writes `Game # 2646539198 - Texas Hold'em No Limit EUR ...`:
    // same two leading tokens, no colon, no `Table <currency><digits> <limit>`.
    const entraction = [
      "Game # 2646539198 - Texas Hold'em No Limit EUR 0.25/0.50 - Table \"Burguillos\"",
      "",
      "Players(max 6):",
      "Pinokio1                    (EUR 50.25 in seat 3)",
    ].join("\n");
    for (const candidate of detectSite(entraction)) {
      expect(candidate.parser.id).not.toBe("unibet");
    }
  });

  it("does not claim PokerStars, GGPoker or standard text", () => {
    const foreign = [
      [
        "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
        "Table 'Aaltje II' 6-max Seat #2 is the button",
      ].join("\n"),
      [
        "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
        "Table 'NLHPurple70' 6-max Seat #1 is the button",
      ].join("\n"),
    ];
    for (const text of foreign) {
      for (const candidate of detectSite(text)) {
        expect(candidate.parser.id).not.toBe("unibet");
      }
    }
  });
});
