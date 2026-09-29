import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handClass, omahaHandClass } from "../../frontend/src/lib/cards.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { variantFromLabel as sharedVariantFromLabel } from "../../frontend/src/lib/parsers/shared/ps-gg-hand.js";
import {
  ParseSkip,
  registerParser,
  unregisterParser,
  unsupportedGameSkip,
  type SiteParser,
} from "../../frontend/src/lib/phf/detect.js";
import {
  parseStandardHand,
  splitStandardHands,
  toStandardText,
} from "../../frontend/src/lib/phf/serialize.js";
import {
  holeCardCount,
  isHiLoLabel,
  variantFromLabel,
  type PhfHand,
} from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";

/**
 * Omaha, short deck and high-low split.
 *
 * Two issues meet in this file. The first is that "Omaha Hi/Lo" used to read as
 * plain `omaha`, which is the most dangerous kind of wrong: half the pot goes
 * to the low hand, but the hand still balances against itself - the summary
 * says who collected what - so the validator passes it and every statistic
 * computed over it is quietly false. The second is the rest of core PLO:
 * four-, five- and six-card deals through the validator, the text serializer
 * and the starting-hand class.
 *
 * No parser is unlocked here. These tests go through the standard-text reader,
 * which is the one path that already accepts an Omaha hand, plus the real site
 * fixtures for the refusals.
 */

const ROOT = join(import.meta.dirname, "../..");
const SAMPLES = join(ROOT, "fixtures/samples");
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

function sample(relative: string): string {
  return readFileSync(join(SAMPLES, relative), "utf8");
}

function ggFixtures(match: RegExp): Array<{ name: string; text: string }> {
  const dir = join(SAMPLES, "ggpoker");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".txt") && match.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

function parse(text: string): PhfHand {
  const hand = parseStandardHand(text, CTX);
  if (!hand) {
    throw new Error("fixture did not parse");
  }
  return hand;
}

/* ------------------------------------------------------------------ hi/lo - */

describe("high-low split is recognised, not collapsed into Omaha", () => {
  it("reads every spelling the sample corpus actually contains", () => {
    // Each of these is a verbatim game label from a file under
    // `fixtures/samples/`. Missing one means a real split-pot hand is booked as
    // a high-only hand, so the list is the corpus, not a guess.
    const labels = [
      "Omaha Hi/Lo Pot Limit", // PokerStars 17, 21, 26
      "Omaha Hi/Lo Limit", // PokerStars 15
      "7 Card Stud Hi/Lo Limit", // PokerStars 44
      "PL Omaha Hi-Lo", // partypoker 08
      "Omaha Hi/Lo Fixed Limit", // Entraction 06, 12
      "Omaha H/L", // Microgaming 09
      "OMAHA HiLo", // Bovada / Ignition
      "Omaha HiLow", // ACR / WPN
      "GAME_OMAHL", // Boss Media 05
      "PLO8",
      "Omaha/8",
      "$1/$2 Omaha 8 or Better",
    ];
    for (const label of labels) {
      expect(isHiLoLabel(label), label).toBe(true);
    }
  });

  it("does not see hi/lo where there is none", () => {
    // `Omaha Hi` is a real label for the high-only game, and the `8-max` in a
    // table description is not an eight-or-better. A false positive here costs
    // a refused hand; being sloppy about it would cost a lot of them.
    const labels = [
      "Hold'em No Limit",
      "Omaha Pot Limit",
      "Omaha Hi",
      "PLO-5",
      "PLO",
      "5 Card Omaha Pot Limit",
      "ShortDeck No Limit",
      "Razz Limit",
      "NL Hold'em 8-max",
      "Badugi Limit",
    ];
    for (const label of labels) {
      expect(isHiLoLabel(label), label).toBe(false);
    }
  });

  it("keeps the variant deal-shaped: Omaha Hi/Lo is still four-card Omaha", () => {
    // The flag carries the award rule; `Variant` carries the deal. If this ever
    // returns something like "omaha-hilo", `holeCardCount` stops knowing the
    // answer and the cardinality check below silently switches itself off.
    expect(variantFromLabel("Omaha Hi/Lo Pot Limit")).toBe("omaha");
    expect(variantFromLabel("5 Card Omaha Hi/Lo")).toBe("omaha5");
    expect(variantFromLabel("7 Card Stud Hi/Lo Limit")).toBe("stud");
    expect(holeCardCount(variantFromLabel("Omaha Hi/Lo Pot Limit"))).toBe(4);
  });

  it("refuses the real partypoker split-pot fixture with its own reason", async () => {
    // `fixtures/samples/partypoker/08-omaha-hilo-split-pot.txt`, which ends:
    //   robertp10 wins $28.75 USD from the main pot with a pair of Kings.
    //   fistfock123 wins Lo ($28.75 USD) from the main pot with 7,5,4,2,A.
    // Read as plain Omaha that hand balances perfectly. Nothing downstream
    // would ever have flagged it.
    const result = await convertAny(sample("partypoker/08-omaha-hilo-split-pot.txt"), {
      sourceFilename: "08-omaha-hilo-split-pot.txt",
    });
    expect(result.hands).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toBe("unsupported-hi-lo");
    expect(result.failures[0].detectedSite).toBe("partypoker");
    expect(result.failures[0].message).toContain("high-low split");
    // The raw text is kept, which is the other half of the refusal principle.
    expect(result.failures[0].rawText).toContain("Omaha Hi-Lo");
  });

  it("refuses the PokerStars hi/lo fixtures for the same reason", async () => {
    const files = [
      "pokerstars/14-cash-omahahilo-strange-names.txt",
      "pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt",
      "pokerstars/17-cash-omahahilo-nolowqualified.txt",
      "pokerstars/21-cash-omahahilo-mucks-hand.txt",
      "pokerstars/26-cash-nolimit-omahahilo.txt",
      "pokerstars/44-cash-7stud-hilo-brings-in-streets-excerpt.txt",
    ];
    for (const file of files) {
      const result = await convertAny(sample(file), { sourceFilename: file });
      expect(result.hands, file).toEqual([]);
      expect(new Set(result.failures.map((failure) => failure.reason)), file).toEqual(
        new Set(["unsupported-hi-lo"]),
      );
    }
  });

  it("sets the flag on a hand read back out of standard text", () => {
    const hand = parse(HI_LO_TEXT);
    expect(hand.game.hiLo).toBe(true);
    expect(hand.game.variant).toBe("omaha");
    // And the flag survives a text round trip, because both sides derive it
    // from the label the source printed.
    expect(parse(toStandardText(hand)).game.hiLo).toBe(true);
  });

  it("leaves the flag off every hand the corpus does convert", async () => {
    const result = await convertAny(sample("ggpoker/01-repo-cash-rushcash-GG20260217-0405 - NLHPurple70 - 0.25 - 0.5 - 6max.txt"));
    expect(result.hands.length).toBeGreaterThan(10);
    expect(result.hands.every((hand) => hand.game.hiLo === false)).toBe(true);
  });

  it("refuses a hi/lo hand from any parser, even one that forgets to check", async () => {
    // The backstop in `convertAny`. A site parser that never calls
    // `unsupportedGameSkip` still cannot get a split-pot hand into storage,
    // which is what makes the guarantee total rather than per-parser.
    const forgetful: SiteParser = {
      id: "test-forgetful",
      name: "Forgetful",
      version: "1.0.0",
      detect: (text) => (text.startsWith("FORGETFUL") ? 1 : 0),
      splitHands: (text) => [text],
      parseHand: (raw) => {
        const hand = parse(HI_LO_TEXT);
        hand.meta.rawText = raw;
        return hand;
      },
    };
    registeredForCleanup.push(forgetful.id);
    registerParser(forgetful);

    const result = await convertAny("FORGETFUL\n", { siteId: forgetful.id });
    expect(result.hands).toEqual([]);
    expect(result.failures.map((failure) => failure.reason)).toEqual(["unsupported-hi-lo"]);
    expect(result.failures[0].stage).toBe("parse");
  });

  it("offers parsers a ready-made refusal and stays quiet about everything else", () => {
    const skip = unsupportedGameSkip("PL Omaha Hi-Lo");
    expect(skip).toBeInstanceOf(ParseSkip);
    expect(skip!.reason).toBe("unsupported-hi-lo");
    expect(skip!.stage).toBe("parse");
    expect(unsupportedGameSkip("Omaha Pot Limit")).toBeNull();
  });
});

const registeredForCleanup: string[] = [];
afterEach(() => {
  while (registeredForCleanup.length > 0) {
    unregisterParser(registeredForCleanup.pop()!);
  }
});

/* --------------------------------------------------------------- variants - */

describe("one reading of the game label", () => {
  it("is literally the same function on both sides of the round trip", () => {
    // There used to be two implementations, and the thinner one - the one
    // `parseStandardText` used - read `PLO-5` as four-card Omaha. Nothing
    // compared them because every Omaha hand was refused before it got that
    // far, so the disagreement was invisible until a PLO parser unlocked.
    expect(sharedVariantFromLabel).toBe(variantFromLabel);
  });

  it("reads every Omaha and short-deck label the rooms print", () => {
    const cases: Array<[string, string]> = [
      ["Omaha Pot Limit", "omaha"],
      ["PLO", "omaha"],
      ["Omaha No Limit", "omaha"],
      ["Omaha (NL postflop)", "omaha"],
      ["PLO-5", "omaha5"],
      ["5 Card Omaha Pot Limit", "omaha5"],
      ["PLO-6", "omaha6"],
      ["6 Card Omaha Pot Limit", "omaha6"],
      ["ShortDeck No Limit", "shortdeck"],
      ["6+ Hold'em", "shortdeck"],
      ["Hold'em No Limit", "holdem"],
    ];
    for (const [label, variant] of cases) {
      expect(variantFromLabel(label), label).toBe(variant);
    }
  });

  it("knows how many cards each deal gives a seat", () => {
    expect(holeCardCount("holdem")).toBe(2);
    expect(holeCardCount("shortdeck")).toBe(2);
    expect(holeCardCount("omaha")).toBe(4);
    expect(holeCardCount("omaha5")).toBe(5);
    expect(holeCardCount("omaha6")).toBe(6);
    // Stud, razz and draw deal a changing number of cards per street; there is
    // no single answer, and `null` means "do not check" rather than "zero".
    expect(holeCardCount("stud")).toBeNull();
    expect(holeCardCount("draw")).toBeNull();
  });
});

/* -------------------------------------------------------------- validator - */

describe("hole-card cardinality is variant aware", () => {
  it("accepts the right count at 2, 4, 5 and 6 cards", () => {
    const cases: Array<[string, string[]]> = [
      ["Hold'em No Limit", ["5s", "8c"]],
      ["Omaha Pot Limit", ["5s", "8c", "2h", "3d"]],
      ["PLO-5", ["5s", "8c", "2h", "3d", "7c"]],
      ["PLO-6", ["5s", "8c", "2h", "3d", "7c", "9s"]],
    ];
    for (const [label, cards] of cases) {
      const hand = parse(omahaText(label, cards));
      expect(hand.players.find((player) => player.isHero)!.holeCards, label).toEqual(cards);
      const report = validateHand(hand);
      expect(report.ok, label).toBe(true);
      expect(
        report.problems.map((problem) => problem.code),
        label,
      ).not.toContain("hole-card-count");
    }
  });

  it("refuses a seat holding more cards than the deal gives it", () => {
    // The shape a mis-classified hand takes: five cards under a four-card
    // label. It cannot be a partial reveal, so it is an error rather than a
    // warning - `convertAny` turns it into a refusal.
    const hand = parse(omahaText("Omaha Pot Limit", ["5s", "8c", "2h", "3d", "7c"]));
    const report = validateHand(hand);
    expect(report.ok).toBe(false);
    expect(report.errors.map((problem) => problem.code)).toContain("hole-card-overflow");
    expect(report.errors[0].message).toContain("omaha deals 4");
  });

  it("only warns about a seat holding fewer, because rooms really do that", () => {
    // `fixtures/samples/ggpoker/03-...` has a Hold'em seat that shows exactly
    // one card, and `11-...shortdeck...` has another. A partial reveal is true
    // as far as it goes, so it must not cost the hand.
    const hand = parse(omahaText("Omaha Pot Limit", ["5s", "8c", "2h"]));
    const report = validateHand(hand);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((problem) => problem.code)).toContain("hole-card-count");
  });

  it("leaves a hand with no shown cards alone", () => {
    const hand = parse(omahaText("PLO-5", ["5s", "8c", "2h", "3d", "7c"]));
    for (const player of hand.players) {
      player.holeCards = [];
    }
    expect(validateHand(hand).problems.map((problem) => problem.code)).not.toContain(
      "hole-card-count",
    );
  });

  it("does not check a variant whose deal size changes by street", () => {
    const hand = parse(omahaText("7 Card Stud Limit", ["5s", "8c", "2h"]));
    expect(hand.game.variant).toBe("stud");
    expect(validateHand(hand).problems.map((problem) => problem.code)).not.toContain(
      "hole-card-count",
    );
  });
});

/* ------------------------------------------------------------- serializer - */

describe("standard text carries four to six hole cards", () => {
  const omahaFiles = ggFixtures(/plo|omaha|shortdeck/i);

  it("finds the Omaha and short-deck fixtures", () => {
    expect(omahaFiles.length).toBeGreaterThan(10);
  });

  it("reads the variant and the limit off the label", () => {
    // `PLO-5 ($2/$5)` states the limit inside the game name and nowhere else.
    // Both facts used to come out wrong: `omaha` instead of `omaha5` because
    // the serializer had its own thinner label reader, and `nl` instead of
    // `pl` because no test matched `PLO`.
    const seen = new Map<string, string>();
    for (const file of omahaFiles) {
      for (const chunk of splitStandardHands(file.text)) {
        const hand = parse(chunk);
        seen.set(`${hand.game.label} -> ${hand.game.variant}/${hand.game.limit}`, file.name);
      }
    }
    expect([...seen.keys()].sort()).toEqual([
      // GG's bare `PLO` names a pot-limit game and says so nowhere else.
      "Omaha (NL postflop) -> omaha/nl",
      "Omaha No Limit -> omaha/nl",
      "Omaha Pot Limit -> omaha/pl",
      "PLO -> omaha/pl",
      "PLO-5 -> omaha5/pl",
      "ShortDeck No Limit -> shortdeck/nl",
    ]);
  });

  it("deals the right number of cards to every seat that showed them", () => {
    for (const file of omahaFiles) {
      for (const chunk of splitStandardHands(file.text)) {
        const hand = parse(chunk);
        const expected = holeCardCount(hand.game.variant)!;
        for (const player of hand.players) {
          if (player.holeCards.length > 0) {
            expect(player.holeCards.length, `${file.name} ${player.name}`).toBeLessThanOrEqual(
              expected,
            );
          }
        }
      }
    }
  });

  it("re-serializes a five-card hand byte for byte", () => {
    // The `Dealt to` line is the one that changes shape, and the trackers that
    // import this text are byte sensitive.
    for (const file of ggFixtures(/plo5|plo-6max|shortdeck/i)) {
      for (const chunk of splitStandardHands(file.text)) {
        const hand = parse(chunk);
        const out = toStandardText(hand);
        for (const line of out.split("\n")) {
          if (line.startsWith("Dealt to ") && line.includes("[")) {
            expect(chunk, file.name).toContain(line);
          }
        }
      }
    }
    const plo5 = ggFixtures(/plo5/)[0];
    for (const chunk of splitStandardHands(plo5.text)) {
      expect(toStandardText(parse(chunk)), plo5.name).toBe(chunk);
    }
  });

  it("survives parse -> serialize -> parse with the same hand in it", () => {
    for (const file of ggFixtures(/plo5|plo-6max/i)) {
      for (const chunk of splitStandardHands(file.text)) {
        const first = parse(chunk);
        const second = parse(toStandardText(first));
        expect(second.game, file.name).toEqual(first.game);
        expect(
          second.players.map((player) => player.holeCards),
          file.name,
        ).toEqual(first.players.map((player) => player.holeCards));
        expect(second.board, file.name).toEqual(first.board);
      }
    }
  });

  it("writes a six-card hand the reader gets back unchanged", () => {
    const cards = ["Ah", "Kd", "Qc", "Js", "Th", "9d"];
    const hand = parse(omahaText("PLO-6", cards));
    const text = toStandardText(hand);
    expect(text).toContain(`Dealt to Hero [${cards.join(" ")}]`);
    expect(parse(text).players.find((player) => player.isHero)!.holeCards).toEqual(cards);
  });
});

/* ------------------------------------------------------------- hand class - */

describe("Omaha starting-hand class", () => {
  it("names the suit structure", () => {
    expect(omahaHandClass(["Ah", "Kh", "Qd", "Jd"])).toBe("AKQJ-22"); // double suited
    expect(omahaHandClass(["Ah", "Kh", "Qd", "Jc"])).toBe("AKQJ-2"); // single suited
    expect(omahaHandClass(["Ah", "Ks", "Qd", "Jc"])).toBe("AKQJ-r"); // rainbow
    expect(omahaHandClass(["Ah", "Kh", "Qh", "Jc"])).toBe("AKQJ-3"); // three-flush
    expect(omahaHandClass(["Ah", "Kh", "Qh", "Jh"])).toBe("AKQJ-4"); // monotone
  });

  it("sorts ranks high to low whatever order they arrive in", () => {
    expect(omahaHandClass(["2c", "Js", "Ah", "7d"])).toBe("AJ72-r");
    expect(omahaHandClass(["Ah", "As", "Kh", "Ks"])).toBe("AAKK-22");
    expect(omahaHandClass(["Td", "Th", "Ts", "Tc"])).toBe("TTTT-r");
  });

  it("uses the same rules at five and six cards", () => {
    expect(omahaHandClass(["Ah", "Kh", "Qd", "Jd", "Tc"])).toBe("AKQJT-22");
    expect(omahaHandClass(["Ah", "Kh", "Qh", "Jd", "Td"])).toBe("AKQJT-32");
    expect(omahaHandClass(["Ah", "Kh", "Qd", "Jd", "Tc", "9c"])).toBe("AKQJT9-222");
    expect(omahaHandClass(["Ah", "Ks", "Qd", "Jc", "Th", "9s"])).toBe("AKQJT9-22");
  });

  it("refuses anything that is not a legal Omaha holding", () => {
    expect(omahaHandClass(["Ah", "Kd"])).toBeNull(); // that is `handClass`'s job
    expect(omahaHandClass(["Ah", "Kd", "Qc"])).toBeNull();
    expect(omahaHandClass(["Ah", "Kd", "Qc", "Js", "Th", "9d", "8c"])).toBeNull();
    expect(omahaHandClass(["Ah", "Kd", "Qc", "Xx"])).toBeNull();
    // The same card twice means the hand is not trustworthy, so there is no
    // class to give it.
    expect(omahaHandClass(["Ah", "Ah", "Qc", "Js"])).toBeNull();
  });

  it("does not disturb the Hold'em class", () => {
    expect(handClass(["Ah", "Kh"])).toBe("AKs");
    expect(handClass(["Ah", "Kd"])).toBe("AKo");
    expect(handClass(["Ah", "Ad"])).toBe("AA");
    expect(handClass(["Ah", "Kd", "Qc", "Js"])).toBeNull();
  });

  it("produces a value the database will accept", () => {
    // The check constraint and the function that feeds it are in different
    // languages in different directories; the only thing keeping them in step
    // is this test, which reads the pattern straight out of the migration.
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/20261004090000_omaha_hand_class.sql"),
      "utf8",
    );
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const patterns = [...statements.matchAll(/hero_hand_class ~ '(\^[^']+\$)'/g)].map(
      (match) => new RegExp(match[1]),
    );
    expect(patterns).toHaveLength(2);
    const accepts = (value: string) => patterns.some((pattern) => pattern.test(value));

    for (const cards of [
      ["Ah", "Kh", "Qd", "Jd"],
      ["Ah", "Ks", "Qd", "Jc"],
      ["Ah", "Kh", "Qh", "Jh"],
      ["Ah", "Kh", "Qd", "Jd", "Tc"],
      ["2h", "3h", "4d", "5d", "6c", "7c"],
      ["Th", "Ts", "Td", "Tc", "9h", "9s"],
    ]) {
      const value = omahaHandClass(cards)!;
      expect(value, cards.join("")).not.toBeNull();
      expect(accepts(value), value).toBe(true);
    }
    for (const cards of [
      ["Ah", "Kh"],
      ["Ah", "Kd"],
      ["Ah", "Ad"],
      ["7h", "2c"],
    ]) {
      expect(accepts(handClass(cards)!), cards.join("")).toBe(true);
    }
    // And the guard is still a guard.
    expect(accepts("Omaha, four cards, double suited")).toBe(false);
    expect(accepts("AKQJ-")).toBe(false);
    expect(accepts("AKQJ")).toBe(false);
  });
});

/* ------------------------------------------------------------- test data -- */

/**
 * One real Hold'em hand relabelled, so the only thing under test is the deal.
 *
 * Every amount, action and board card is left alone; the label and the hero's
 * hole cards are substituted. The board is `Tc 4h Ad`, so the substituted cards
 * stay clear of it and the duplicate-card check is not what fails.
 */
function omahaText(label: string, heroCards: string[]): string {
  return BASE_HAND.replace("Hold'em No Limit", label).replace(
    "Dealt to Hero [5s 8c]",
    `Dealt to Hero [${heroCards.join(" ")}]`,
  );
}

const BASE_HAND = `Poker Hand #HD2735958902: Hold'em No Limit ($0.25/$0.5) - 2026/02/17 05:56:01
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

const HI_LO_TEXT = omahaText("Omaha Hi/Lo Pot Limit", ["5s", "8c", "2h", "3d"]);
