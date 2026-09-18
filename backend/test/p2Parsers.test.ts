/**
 * 888poker, partypoker and iPoker, over their whole fixture corpora.
 *
 * Table driven over the directories rather than over cherry-picked hands: the
 * point of the corpora is to catch the line shape nobody thought of, which only
 * happens if every file is run every time.
 *
 * The assertions are the same real invariants the WePlay suite makes - no
 * unknown lines, chip conservation, no negative stack mid-hand, the whole pot
 * paid out - plus the refusals, because a refusal with the wrong reason is a
 * silent failure too.
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
import { otherSampleSites, sampleFiles, type SampleFile } from "./support/p2Corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

const SITES = [
  { id: "888poker", dir: "888poker", name: "888poker" },
  { id: "partypoker", dir: "partypoker", name: "partypoker" },
  { id: "ipoker", dir: "ipoker", name: "iPoker Network" },
] as const;

/**
 * Reasons these parsers are allowed to refuse a hand with.
 *
 * Anything outside this list is either a parser bug or a reason that needs
 * writing down, so the list is deliberately closed.
 */
const ALLOWED_REASONS = new Set([
  // Round one is Hold'em; the corpora are heavily Omaha.
  "unsupported-variant",
  // The European 888 client writes `25 $/50 $` and `3 023,50 $`.
  "unsupported-locale",
  // Source text that stops before the hand is settled.
  "truncated-hand",
  "no-winner",
  // Source text that contradicts itself.
  "inconsistent-pot",
  "unseated-actor",
  "board-size",
  "too-few-players",
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

/**
 * Which PartyGaming dialect a file is written in, decided without asking a
 * parser.
 *
 * 888 stamps `... Blinds <game> - *** DD MM YYYY HH:MM:SS` under the banner;
 * partypoker stamps a weekday name and a timezone. The harvested corpus files a
 * couple of genuine partypoker hands under 888, and the directory layout is the
 * research agent's to change, so the *text* decides which parser owns a file -
 * never the folder it happens to sit in.
 */
const P888_DIALECT = /^[^\n]*\bBlinds\b[^\n]*-\s+\*\*\*\s+\d{2}\s+\d{2}\s+\d{4}/m;

function dialectOf(file: SampleFile): "888poker" | "partypoker" {
  return P888_DIALECT.test(file.text) ? "888poker" : "partypoker";
}

/** The samples that belong to `site`, wherever in the fixture tree they live. */
function siteFiles(site: (typeof SITES)[number]): SampleFile[] {
  if (site.id === "ipoker") {
    return sampleFiles("ipoker");
  }
  return [...sampleFiles("888poker"), ...sampleFiles("partypoker")].filter(
    (file) => dialectOf(file) === site.id,
  );
}

function eachFile(site: (typeof SITES)[number]): Array<readonly [string, SampleFile]> {
  return siteFiles(site).map((file) => [file.relativePath, file] as const);
}

for (const site of SITES) {
  const files = eachFile(site);

  describe(`${site.name} corpus`, () => {
    it("finds the corpus", () => {
      // The corpora are curated upstream and can shrink; the bar only has to
      // catch a directory that has gone missing entirely.
      expect(files.length).toBeGreaterThan(10);
    });

    it.each(files)("%s is attributed to its own parser", (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe(site.id);
      expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it.each(files)("%s converts or refuses with a reason", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      expect(result.stats.total).toBeGreaterThan(0);
      expect(result.stats.total).toBe(result.stats.converted + result.stats.failed);

      for (const failure of result.failures) {
        expect(ALLOWED_REASONS, `${failure.reason}: ${failure.message}`).toContain(failure.reason);
        expect(failure.detectedSite).toBe(site.id);
        expect(failure.message.length).toBeGreaterThan(10);
      }

      for (const hand of result.hands) {
        const where = `${file.name} ${hand.meta.handId}`;
        // An unrecognised source line becomes a warning rather than a silent
        // drop, so an empty warning list is what proves full line coverage.
        expect(hand.meta.warnings, where).toEqual([]);
        expect(validateHand(hand).errors, where).toEqual([]);
        expect(hand.meta.siteId).toBe(site.id);
        expect(hand.meta.rawText.length).toBeGreaterThan(0);
        expect(hand.game.variant).toBe("holdem");
      }
    });

    it.each(files)("%s conserves chips in every hand", async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      for (const hand of result.hands) {
        const where = `${file.name} ${hand.meta.handId}`;
        const contributed = [...contributionsFromActions(hand).values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        expect(contributed, `${where} in`).toBe(hand.results.totalPot);

        const paid = hand.results.winners.reduce((sum, winner) => sum + winner.amount, 0);
        // Every one of these rooms reports a pot the rake has already come out
        // of, so the two have to add back up to the stated total exactly.
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

    it.each(files)("%s round-trips through standard text", async (_name, file) => {
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

    it.each(files)("%s replays without a negative stack", async (_name, file) => {
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
}

describe("hand keys", () => {
  it("prefixes every site so ids from the same lineage cannot collide", async () => {
    // The partypoker corpus really does contain two different hands numbered
    // 1458965856, and 888 and partypoker share a numbering scheme, so the key
    // has to carry the room.
    const prefixes: Record<string, string> = {
      "888poker": "888-",
      partypoker: "PTY-",
      ipoker: "IPN-",
    };
    for (const site of SITES) {
      for (const file of siteFiles(site).slice(0, 6)) {
        const result = await convertAny(file.text, { sourceFilename: file.name });
        for (const hand of result.hands) {
          expect(hand.meta.handKey).toBe(hand.meta.handId);
          expect(hand.meta.handId.startsWith(prefixes[site.id]), hand.meta.handId).toBe(true);
        }
      }
    }
  });
});

describe("detection is a shared namespace", () => {
  const mine = SITES.map((site) => site.id);

  it.each(otherSampleSites(SITES.map((site) => site.dir)).map((name) => [name] as const))(
    "no 888poker/partypoker/iPoker parser claims a %s sample",
    (dir) => {
      const claims: string[] = [];
      for (const file of sampleFiles(dir)) {
        for (const candidate of detectSite(file.text)) {
          if (mine.includes(candidate.parser.id)) {
            claims.push(`${candidate.parser.id} claims ${file.relativePath}`);
          }
        }
      }
      expect(claims).toEqual([]);
    },
  );

  it("does not claim PokerStars or GGPoker text", () => {
    const pokerstars = [
      "PokerStars Hand #123456789:  Hold'em No Limit ($0.05/$0.10 USD) - 2014/01/06 8:54:23 ET",
      "Table 'Aaltje II' 6-max Seat #2 is the button",
      "Seat 1: villain ($10 in chips)",
    ].join("\n");
    const gg = [
      "Poker Hand #HD123: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01",
      "Table 'NLHPurple70' 6-max Seat #1 is the button",
    ].join("\n");
    for (const text of [pokerstars, gg]) {
      for (const candidate of detectSite(text)) {
        expect(mine).not.toContain(candidate.parser.id);
      }
    }
  });

  it("refuses to claim 888 text as partypoker and the other way round", () => {
    // Both rooms print the same banner; only the line under it differs. These
    // two are written out here rather than read from the corpus so the check
    // survives the fixture tree being reorganised.
    const p888 = [
      "#Game No : 349736402",
      "***** 888poker Hand History for Game 349736402 *****",
      "$0.05/$0.10 Blinds No Limit Holdem - *** 06 01 2014 22:40:28",
      "Table Abbotsford 6 Max (Real Money)",
    ].join("\n");
    const party = [
      "***** Hand History for Game 13550420797 *****",
      "$0.05/$0.10 USD NL Texas Hold'em - Monday, January 06, 05:54:36 EST 2014",
      "Table Almeria (Real Money)",
    ].join("\n");
    expect(detectSite(p888).map((candidate) => candidate.parser.id)).toEqual(["888poker"]);
    expect(detectSite(party).map((candidate) => candidate.parser.id)).toEqual(["partypoker"]);
  });

  it("goes by the text when a sample is filed under the wrong room", () => {
    // The harvested corpus has filed genuine partypoker hands under 888 before
    // now, so every sample in either directory has to land on the parser whose
    // dialect it is actually written in.
    for (const dir of ["888poker", "partypoker"]) {
      for (const file of sampleFiles(dir)) {
        expect(detectSite(file.text)[0]?.parser.id, file.relativePath).toBe(dialectOf(file));
      }
    }
  });
});
