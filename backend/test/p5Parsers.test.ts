/**
 * Ignition / Bodog / Bovada and ACR / Winning Poker Network.
 *
 * Both suites are table driven over the whole sample corpus and both decide
 * what a hand *is* from the text rather than from the directory it sits in: the
 * upstream fixture sets are named by the tracker that collected them, and a
 * name is not evidence. Every hand that converts has to satisfy the same
 * invariants the PokerStars and GGPoker suites assert - chip conservation, no
 * negative stack mid-hand, the whole pot paid out, a clean round trip through
 * standard text - and every hand that does not convert has to carry a
 * machine-readable reason from a list this file spells out.
 *
 * The WPN table reports **per dialect**. One aggregate number would hide a
 * grammar era failing wholesale, which is the specific way a three-grammar
 * parser goes wrong.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acrwpnParser,
  detectSite,
  ignitionParser,
  ParseSkip,
  type SiteParser,
} from "../../frontend/src/lib/parsers/index.js";
import { wpnDialect, type WpnDialect } from "../../frontend/src/lib/parsers/acrwpn.js";
import { p5RecoverEncoding } from "../../frontend/src/lib/parsers/shared/p5-encoding.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { type PhfHand } from "../../frontend/src/lib/phf/types.js";
import { sampleFiles, type CorpusFile } from "./support/psggCorpus.js";
import { allInvariants } from "./support/psggInvariants.js";

/* ------------------------------------------------------------------ helpers */

interface Outcome {
  file: string;
  chunk: string;
  hand: PhfHand | null;
  reason: string | null;
  message: string;
}

/** Runs one parser over one corpus directory, chunk by chunk. */
function run(parser: SiteParser, site: string): Outcome[] {
  const out: Outcome[] = [];
  for (const file of sampleFiles(site)) {
    for (const chunk of parser.splitHands(file.text)) {
      try {
        const hand = parser.parseHand(chunk, {
          sourceFilename: file.name,
          options: {},
        });
        out.push({ file: file.name, chunk, hand, reason: null, message: "" });
      } catch (error) {
        if (error instanceof ParseSkip) {
          out.push({
            file: file.name,
            chunk,
            hand: null,
            reason: error.reason,
            message: error.message,
          });
          continue;
        }
        out.push({
          file: file.name,
          chunk,
          hand: null,
          reason: "parser-error",
          message: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
        });
      }
    }
  }
  return out;
}

/** Warning codes that mean the parser did not understand a line of the source. */
const BLIND_SPOTS = ["unknown-line", "unknown-summary-line"];

function blindSpots(hand: PhfHand): string[] {
  return hand.meta.warnings
    .filter((warning) => BLIND_SPOTS.includes(warning.code))
    .map((warning) => `${hand.meta.handId} ${warning.code}: ${warning.message}`);
}

/**
 * Every sample directory of `.txt` hand histories that belongs to another
 * parser.
 *
 * `ipoker` (XML) and `phh` (the `.phh` interchange format) are absent because
 * the shared loader only reads `.txt`; both get their own check below.
 * `wpt-global` is absent because its corpus is still empty.
 */
const OTHER_SITES = [
  "888poker",
  "bossmedia",
  "chico",
  "coinpoker",
  "entraction",
  "full-tilt",
  "ggpoker",
  "merge",
  "microgaming",
  "ongame",
  "partypoker",
  "pokerbros",
  "pokerstars",
  "run-it-once",
  "unibet",
  "weplay",
  "winamax",
];

function foreignFiles(): Array<[string, CorpusFile]> {
  return OTHER_SITES.flatMap((site) =>
    sampleFiles(site).map((file) => [file.relativePath, file] as [string, CorpusFile]),
  );
}

/* ---------------------------------------------------------------- ignition - */

const IGNITION_BRAND =
  /^\ufeff?(?:Ignition|Bovada|Bodog\.com|Bodog\.eu|Bodog UK|Bodog Canada|Bodog88|Bodog)\s+Hand\s+#/;

const ignitionOutcomes = run(ignitionParser, "ignition");
/** Hold'em is decided from the header token, not from the file name. */
const ignitionHoldem = ignitionOutcomes.filter((outcome) =>
  /Hand #\S+:?\s+(?:Zone Poker ID#\S+\s+|TBL#\S+\s+)?HOLDEM(?:ZonePoker)?\b/.test(outcome.chunk),
);

describe("Ignition / Bodog / Bovada", () => {
  it("splits the corpus into the hands the brand header announces", () => {
    let headers = 0;
    for (const file of sampleFiles("ignition")) {
      headers += file.text.split(/\r?\n/).filter((line) => IGNITION_BRAND.test(line)).length;
    }
    expect(ignitionOutcomes).toHaveLength(headers);
    // The corpus is 2012-2022 and covers six brand strings; if it shrinks, the
    // numbers below stop meaning anything.
    expect(headers).toBeGreaterThanOrEqual(100);
    expect(ignitionHoldem.length).toBeGreaterThanOrEqual(85);
  });

  it.each(sampleFiles("ignition").map((file) => [file.relativePath, file] as const))(
    "%s is detected as Ignition",
    (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe("ignition");
      expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    },
  );

  it("converts every hold'em hand the corpus is not itself broken in", () => {
    const refused = ignitionHoldem.filter((outcome) => outcome.hand === null);
    // Two chunks in the corpus are two hands spliced together mid-line by the
    // upstream export; both are refused on purpose.
    expect(refused.map((outcome) => outcome.reason).sort()).toEqual([
      "corrupt-hand",
      "corrupt-hand",
    ]);
    expect(ignitionHoldem.length - refused.length).toBe(85);
  });

  it("refuses every non-hold'em hand with a machine readable reason", () => {
    const others = ignitionOutcomes.filter((outcome) => !ignitionHoldem.includes(outcome));
    expect(others.length).toBeGreaterThan(0);
    for (const outcome of others) {
      expect(outcome.hand).toBeNull();
      expect(outcome.reason).toBe("unsupported-variant");
    }
  });

  it.each(
    ignitionHoldem
      .filter((outcome): outcome is Outcome & { hand: PhfHand } => outcome.hand !== null)
      .map((outcome) => [`${outcome.file} #${outcome.hand.meta.handId}`, outcome.hand] as const),
  )("%s holds every invariant", (_name, hand) => {
    expect(blindSpots(hand)).toEqual([]);
    expect(validateHand(hand).errors).toEqual([]);
    expect(allInvariants(hand)).toEqual([]);
  });

  it("stores the positional pseudonym as the player name and tags the hero", () => {
    const hand = ignitionHoldem.find(
      (outcome) => outcome.hand?.meta.handId === "3340409736",
    )!.hand!;
    expect(hand.players.map((player) => player.name).sort()).toEqual([
      "Dealer",
      "Hero",
      "Small Blind",
    ]);
    expect(hand.players.find((player) => player.isHero)?.name).toBe("Hero");
    // The pseudonym says `Dealer`; the button seat has to agree with it.
    expect(hand.table.buttonSeat).toBe(6);
  });

  it("never reads a `Showdown [...]` best-five list as hole cards", () => {
    for (const outcome of ignitionHoldem) {
      if (!outcome.hand) {
        continue;
      }
      for (const player of outcome.hand.players) {
        expect(player.holeCards.length === 0 || player.holeCards.length === 2).toBe(true);
      }
    }
  });

  it("records the [MVS] per-seat hashes as provenance rather than identity", () => {
    const mvs = ignitionHoldem.filter((outcome) =>
      outcome.hand?.meta.warnings.some((warning) => warning.code === "mvs-player-hashes"),
    );
    expect(mvs.length).toBe(3);
    for (const outcome of mvs) {
      // Nothing may key off the hash: the seats are still pseudonyms.
      expect(outcome.hand!.players.every((player) => !/[0-9a-f]{32}/.test(player.name))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------- WPN -- */

const wpnOutcomes = run(acrwpnParser, "acr-wpn");
const wpnByDialect = new Map<WpnDialect, Outcome[]>();
for (const outcome of wpnOutcomes) {
  const dialect = wpnDialect(outcome.chunk) ?? "legacy";
  wpnByDialect.set(dialect, [...(wpnByDialect.get(dialect) ?? []), outcome]);
}

/** Hold'em membership read from the header, per dialect. */
function isHoldem(chunk: string): boolean {
  if (/^Game started at:/.test(chunk)) {
    return /^Game ID:.*\(Hold'?em\)/m.test(chunk);
  }
  return /^(?:Game )?Hand #\d+ - (?:.*Tournament #\S+ - )?Hold'?em\(/m.test(chunk);
}

/** Refusals the corpus genuinely earns, with how many hands each accounts for. */
const WPN_EXPECTED_REFUSALS: Record<string, number> = {
  // Two 2016 exports lost the player name on money-moving lines.
  "unnamed-actor": 3,
  // Two hands were cancelled before a card was dealt.
  "cancelled-hand": 2,
  // One hand's summary block is truncated to two of its five seats.
  "payout-mismatch": 1,
};

describe("ACR / Winning Poker Network", () => {
  it.each(sampleFiles("acr-wpn").map((file) => [file.relativePath, file] as const))(
    "%s is detected as WPN",
    (_name, file) => {
      const ranked = detectSite(file.text);
      expect(ranked[0]?.parser.id).toBe("acrwpn");
      expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    },
  );

  it("recovers the UTF-16LE files rather than parsing mojibake", () => {
    const utf16 = sampleFiles("acr-wpn").filter((file) => file.text.includes(" "));
    // 14 of the 76 sample files really are UTF-16LE, uncorrelated with the era.
    expect(utf16.length).toBe(14);
    for (const file of utf16) {
      const recovered = p5RecoverEncoding(file.text);
      expect(recovered).not.toContain(" ");
      expect(recovered).toMatch(/^(?:Game started at:|(?:Game )?Hand #)/);
    }
    // A name that survives the recovery intact, from a UTF-16LE 2016 export.
    const hand = wpnOutcomes.find((outcome) => outcome.hand?.meta.handId === "698333926")?.hand;
    expect(hand?.players.map((player) => player.name)).toContain("Sean LeBlanc");
  });

  it("covers all three dialects", () => {
    expect([...wpnByDialect.keys()].sort()).toEqual(["legacy", "mined", "modern"]);
  });

  it.each([...wpnByDialect.entries()].map(([dialect, list]) => [dialect, list] as const))(
    "%s dialect converts every hold'em hand the source is not itself broken in",
    (dialect, list) => {
      const holdem = list.filter((outcome) => isHoldem(outcome.chunk));
      const refused = holdem.filter((outcome) => outcome.hand === null);
      const converted = holdem.length - refused.length;

      const counts: Record<string, number> = {};
      for (const outcome of refused) {
        counts[outcome.reason ?? "?"] = (counts[outcome.reason ?? "?"] ?? 0) + 1;
      }
      // Reported per dialect on purpose: one aggregate would hide an era that
      // failed wholesale behind the era that did not.
      const expected =
        dialect === "legacy" ? WPN_EXPECTED_REFUSALS : ({} as Record<string, number>);
      expect({ dialect, counts }).toEqual({ dialect, counts: expected });
      expect({ dialect, converted }).toEqual({
        dialect,
        converted: dialect === "legacy" ? 122 : dialect === "modern" ? 6 : 1,
      });

      // Everything that is not hold'em is a deliberate refusal, never a crash.
      for (const outcome of list.filter((entry) => !isHoldem(entry.chunk))) {
        expect(outcome.hand).toBeNull();
        expect(outcome.reason).toBe("unsupported-variant");
      }
    },
  );

  it.each(
    wpnOutcomes
      .filter((outcome): outcome is Outcome & { hand: PhfHand } => outcome.hand !== null)
      .map(
        (outcome) =>
          [
            `${wpnDialect(outcome.chunk)} ${outcome.file} #${outcome.hand.meta.handId}`,
            outcome.hand,
          ] as const,
      ),
  )("%s holds every invariant", (_name, hand) => {
    expect(blindSpots(hand)).toEqual([]);
    expect(validateHand(hand).errors).toEqual([]);
    expect(allInvariants(hand)).toEqual([]);
  });

  it("reads a legacy `raises (N)` as chips added, not as the street total", () => {
    // ButtonSmasher posts 0.10, raises (0.40) and gets 0.25 back; the summary
    // reports Bets: 0.25, which only balances if the raise was an increment.
    const hand = wpnOutcomes.find((outcome) => outcome.hand?.meta.handId === "266886148")!.hand!;
    const raise = hand.actions.find((action) => action.type === "raise")!;
    expect(raise.player).toBe("ButtonSmasher");
    expect(raise.streetTotal).toBe(50);
    expect(hand.results.totalPot).toBe(50);
  });

  it("books an unprinted jackpot drop as a fee instead of losing the chips", () => {
    // `Pot: 7.73. Rake 0.41` on a (JP) table, with 8.39 actually contributed.
    const hand = wpnOutcomes.find((outcome) => outcome.hand?.meta.handId === "261641541")!.hand!;
    expect(hand.results.totalPot).toBe(839);
    expect(hand.results.fees.rake).toBe(41);
    expect(hand.results.fees.jackpot).toBe(25);
  });

  it("flags the data-mined dialect's numeric ids as unusable identities", () => {
    const mined = wpnByDialect.get("mined")!.filter((outcome) => outcome.hand);
    expect(mined).toHaveLength(1);
    const hand = mined[0].hand!;
    expect(hand.meta.warnings.map((warning) => warning.code)).toContain("numeric-player-ids");
    expect(hand.players.every((player) => /^\d+$/.test(player.name))).toBe(true);
  });
});

/* --------------------------------------------------------------- detection - */

describe("detection boundaries", () => {
  it("checks every other site's corpus, not just the ones that still exist", () => {
    // A renamed or emptied sample directory would otherwise turn the whole
    // cross-detection table below into zero assertions.
    for (const site of OTHER_SITES) {
      expect({ site, files: sampleFiles(site).length > 0 }).toEqual({ site, files: true });
    }
  });

  it.each(foreignFiles())("neither parser claims %s", (_name, file) => {
    expect(ignitionParser.detect(file.text)).toBe(0);
    expect(acrwpnParser.detect(file.text)).toBe(0);
  });

  it.each([
    ["fixtures/samples/ipoker/01-basic-hand-pl-omaha-eur.xml"],
    ["fixtures/samples/phh/01-dwan-ivey-2009-nlhe-cash.phh"],
  ])("claims nothing in %s", (path) => {
    // The two corpora the shared `.txt` loader cannot see.
    const text = readFileSync(join(import.meta.dirname, "../..", path), "utf8");
    expect(ignitionParser.detect(text)).toBe(0);
    expect(acrwpnParser.detect(text)).toBe(0);
  });

  it.each(sampleFiles("pokerstars").map((file) => [file.relativePath, file] as const))(
    "%s still ranks PokerStars first",
    (_name, file) => {
      expect(detectSite(file.text)[0]?.parser.id).toBe("pokerstars");
    },
  );

  it("keeps the modern WPN header off PokerStars and vice versa", () => {
    const wpn = [
      "Hand #151588328 - Holdem(No Limit) - $0.01/$0.02 - 2019/11/08 04:43:23 UTC",
      "Fort Lupton 9-max Seat #1 is the button",
      "Seat 1: Somebody ($1.00)",
    ].join("\n");
    const stars = [
      "PokerStars Hand #151588328:  Hold'em No Limit ($0.01/$0.02 USD) - 2019/11/08 4:43:23 ET",
      "Table 'Fort Lupton' 9-max Seat #1 is the button",
      "Seat 1: Somebody ($1.00 in chips)",
    ].join("\n");

    expect(detectSite(wpn)[0]?.parser.id).toBe("acrwpn");
    expect(acrwpnParser.detect(stars)).toBe(0);
    expect(detectSite(stars)[0]?.parser.id).toBe("pokerstars");
  });

  it("does not claim a bare `Hand #` line without the UTC stamp", () => {
    expect(acrwpnParser.detect("Hand #12345 - something else entirely")).toBe(0);
  });
});
