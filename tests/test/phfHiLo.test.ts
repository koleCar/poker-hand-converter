/**
 * High-low split pots (#47): which collect paid which half.
 *
 * The halves are the one fact about a hi/lo hand that its money cannot check.
 * A split pot read as two unrelated wins balances perfectly, so everything
 * here is asserted against the real fixtures where the answer is known from
 * the cards on the table - and, where the room says so itself, from its words.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeAllIn } from "../../frontend/src/lib/equity/allInEv.js";
import { evaluateOmahaLow } from "../../frontend/src/lib/equity/omaha.js";
import { replayerHr } from "../../frontend/src/lib/i18n/ns/replayer.hr.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { assignHiLoHalves } from "../../frontend/src/lib/phf/hilo.js";
import { parseStandardHand, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { validateHand } from "../../frontend/src/lib/phf/validate.js";
import { buildReplay } from "../../frontend/src/lib/replay.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";

const SAMPLES = join(import.meta.dirname, "../../fixtures/samples");
const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/** Decoded the way an upload is: a byte-order mark is dropped. */
function sample(relative: string): string {
  return new TextDecoder("utf-8").decode(readFileSync(join(SAMPLES, relative)));
}

async function hand(relative: string): Promise<PhfHand> {
  const result = await convertAny(sample(relative), { sourceFilename: relative });
  expect(result.failures, relative).toEqual([]);
  expect(result.hands, relative).toHaveLength(1);
  return result.hands[0];
}

function halves(subject: PhfHand) {
  return subject.results.winners.map((winner) => [winner.player, winner.amount, winner.half]);
}

/** Every Omaha hi/lo fixture a parser now converts, one hand or more each. */
const CONVERTED = [
  "888poker/05-omaha-hilo-summary-hi-lo-split.txt",
  "888poker/10-omaha-hilo-hi-only-summary.txt",
  "entraction/06-fixed-limit-omaha-hilo.txt",
  "entraction/08-euro-table.txt",
  "entraction/12-omaha-hilo-showdown-split-pot.txt",
  "full-tilt/03-cash-plo-hilo-showdown-hi-lo-split.txt",
  "full-tilt/08-cash-flo8-fixed-limit-omaha-hilo.txt",
  "full-tilt/14-cash-plo-hilo-chatline-uncalled-bet.txt",
  "ignition/fpdb3-regression-corpus/cash__PLO8-9max-USD-0.02-0.05-201408.corrupted.lines.txt",
  "ignition/fpdb3-regression-corpus/tour__PLO8-9max-USD-10-MTT-201207.txt",
  "ignition/fpdb3-regression-corpus/tour__PLO8-USD-MTT - $1-0.10 - 201409.LOW.vs.LO.txt",
  "ignition/fpdb3-regression-corpus/tour__PLO8-USD-MTT - $10-$1 - 201207.allin.call.pf.txt",
  "microgaming/04-pot-limit-omaha-hilo.txt",
  "microgaming/09-omaha-hilo-showdown-split-pot.txt",
  "partypoker/08-omaha-hilo-split-pot.txt",
  "pokerstars/14-cash-omahahilo-strange-names.txt",
  "pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt",
  "pokerstars/17-cash-omahahilo-nolowqualified.txt",
  "pokerstars/21-cash-omahahilo-mucks-hand.txt",
  "pokerstars/26-cash-nolimit-omahahilo.txt",
];

describe("the eight-or-better low", () => {
  it("plays exactly two cards from the hand and three from the board", () => {
    // 2-4 from the hand, A-3-5 from the board: a wheel, the best low there is.
    expect(evaluateOmahaLow(["2s", "4c", "Kd", "Kh"], ["Ah", "3d", "5c", "Jh", "Qs"])).toBe(
      [5, 4, 3, 2, 1].reduce((sum, rank) => sum * 9 + rank, 0),
    );
    // One low card in the hand is not a low, however good the board.
    expect(evaluateOmahaLow(["2s", "Kc", "Kd", "Qh"], ["Ah", "3d", "5c", "4h", "6s"])).toBeNull();
    // Two low board cards are not enough either.
    expect(evaluateOmahaLow(["2s", "3c", "Kd", "Qh"], ["Ah", "4d", "Jc", "Th", "9s"])).toBeNull();
  });

  it("is counterfeited by a pair, and lower wins", () => {
    // A-2 in the hand with an ace on the board: the hand's ace is dead weight.
    const counterfeited = evaluateOmahaLow(["Ac", "2c", "Kd", "Qh"], ["Ah", "2d", "7c", "8h", "9s"]);
    expect(counterfeited).toBeNull();
    const sevenSix = evaluateOmahaLow(["2s", "3c", "Kd", "Qh"], ["Ah", "6d", "7c", "Jh", "Qs"])!;
    const eightFive = evaluateOmahaLow(["2s", "3c", "Kd", "Qh"], ["Ah", "5d", "8c", "Jh", "Qs"])!;
    expect(sevenSix).toBeLessThan(eightFive);
  });
});

describe("the halves of real split pots", () => {
  it("pays a two-way split high and low (Full Tilt, the room's own words)", async () => {
    // `ReydelMundo wins the high pot ($61.55)` / `pupsaa wins the low pot`.
    expect(halves(await hand("full-tilt/03-cash-plo-hilo-showdown-hi-lo-split.txt"))).toEqual([
      ["ReydelMundo", 6155, "hi"],
      ["pupsaa", 6155, "lo"],
    ]);
  });

  it("quarters a tied low: two low shares beside the high", async () => {
    // Both players hold 7-6-5-3-A; Mindster also has the flush.
    const subject = await hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    expect(halves(subject)).toEqual([
      ["Mindster", 955, "hi"],
      ["Aphily8", 478, "lo"],
      ["Mindster", 477, "lo"],
    ]);
    // Statistics read the money, not the halves: Mindster's three-quarters is
    // one `won`, and the table still sums to the pot minus the rake.
    const facts = handFacts(subject);
    const mindster = facts.seats.find((seat) => seat.player === "Mindster")!;
    expect(mindster.money.won).toBe(955 + 477);
    expect(facts.seats.reduce((sum, seat) => sum + seat.money.net, 0)).toBe(-90);
  });

  it("awards the whole pot high when no low qualifies", async () => {
    // Board `Jh Td 8c 9c 3h`: two low cards, so no low is possible.
    const subject = await hand("pokerstars/17-cash-omahahilo-nolowqualified.txt");
    expect(halves(subject)).toEqual([["HELVER4728", 1706, "hi"]]);
    // 888 says nothing either way; the cards still do.
    expect(halves(await hand("888poker/10-omaha-hilo-hi-only-summary.txt"))).toEqual([
      ["selkoe", 808, "hi"],
    ]);
  });

  it("splits a side pot and the main pot independently", async () => {
    // The side pot's high is a nine-high flush; the main pot's is the queen-high
    // flush of the all-in player, who is not eligible for the side pot. Only
    // comparing winners with winners gets both right.
    expect(halves(await hand("pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt"))).toEqual([
      ["Bluf_To_Much", 210000, "hi"],
      ["LewisFriend", 210000, "lo"],
      ["Crazy Elior", 263750, "hi"],
      ["LewisFriend", 263750, "lo"],
    ]);
  });

  it("reads a scoop printed on two lines as both halves", async () => {
    // `hank1967 collected [ $0.95 ]`, twice: the high and the low.
    expect(halves(await hand("888poker/05-omaha-hilo-summary-hi-lo-split.txt"))).toEqual([
      ["hank1967", 95, "hi"],
      ["hank1967", 95, "lo"],
    ]);
  });

  it("leaves a pot nobody contested unsplit", async () => {
    expect(halves(await hand("pokerstars/14-cash-omahahilo-strange-names.txt"))).toEqual([
      ["wo_ooly :D", 250, undefined],
    ]);
  });

  it("does not trust MicroGaming's `lowhandwin` flag, which marks both winners", async () => {
    // Fixture 04 flags both seats `lowhandwin="1"`; hoop's low cards pair the
    // board, so only theweman has a low.
    expect(halves(await hand("microgaming/04-pot-limit-omaha-hilo.txt"))).toEqual([
      ["theweman", 173, "lo"],
      ["hoop", 173, "hi"],
    ]);
  });

  it("refuses a payout the shown cards contradict", async () => {
    // Entraction 07 pays the whole pot to a pair of queens while the other
    // shown hand holds 8-7-4-2-A. It shares its hand number with fixture 08
    // and not its cards: an edited sample, and not a hand to store.
    const result = await convertAny(sample("entraction/07-allin-showdown.txt"));
    expect(result.hands).toEqual([]);
    expect(result.failures.map((failure) => failure.reason)).toEqual([
      "hi-lo-payout-contradiction",
    ]);
  });
});

describe("every converted hi/lo fixture", () => {
  it.each(CONVERTED)("%s validates, balances and round-trips with its halves", async (file) => {
    const result = await convertAny(sample(file), { sourceFilename: file });
    expect(result.failures, file).toEqual([]);
    expect(result.hands.length, file).toBeGreaterThan(0);
    for (const subject of result.hands) {
      const where = `${file} ${subject.meta.handId}`;
      expect(subject.game.hiLo, where).toBe(true);
      expect(subject.game.variant, where).toBe("omaha");
      // The only note any of them carries is Bovada's 2012 export printing no
      // street markers - nothing about the split.
      expect(
        subject.meta.warnings.filter((warning) => warning.code !== "streets-inferred"),
        where,
      ).toEqual([]);
      const report = validateHand(subject);
      expect(report.errors, where).toEqual([]);
      expect(
        report.warnings.filter((warning) => warning.code.startsWith("hi-lo")),
        where,
      ).toEqual([]);

      // A half on every winner mirrors its collect.
      const collects = subject.actions.filter((action) => action.type === "collect");
      expect(subject.results.winners.map((winner) => winner.half), where).toEqual(
        collects.map((action) => action.half),
      );

      // Standard text carries no labels - it is PokerStars' - and the halves
      // come back from it exactly.
      const text = toStandardText(subject);
      const back = parseStandardHand(text, CTX)!;
      expect(back.meta.warnings, where).toEqual([]);
      expect(back.game.hiLo, where).toBe(true);
      expect(halves(back), where).toEqual(halves(subject));
      expect(toStandardText(back), where).toBe(text);

      // The equity engine still declines.
      const ev = analyzeAllIn(subject);
      expect(ev.applicable ? null : ev.reason, where).toBe("hi-lo");
    }
  });
});

describe("standard text", () => {
  it("writes PokerStars' `No low hand qualified` back, and reads it", async () => {
    const subject = await hand("pokerstars/17-cash-omahahilo-nolowqualified.txt");
    const text = toStandardText(subject);
    expect(text).toContain("HELVER4728 collected $17.06 from pot\nNo low hand qualified\n");
    // A split pot gets no such line.
    const split = toStandardText(await hand("pokerstars/26-cash-nolimit-omahahilo.txt"));
    expect(split).not.toContain("No low hand qualified");
  });

  it("takes our own hi/lo output back in through an upload", async () => {
    const subject = await hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    const result = await convertAny(toStandardText(subject));
    expect(result.failures).toEqual([]);
    expect(result.hands.map((back) => back.meta.siteId)).toEqual(["standard"]);
    expect(halves(result.hands[0])).toEqual(halves(subject));
  });

  it("warns when the text says no low qualified but a low half was paid", async () => {
    const split = toStandardText(await hand("pokerstars/26-cash-nolimit-omahahilo.txt"));
    const forged = split.replace(
      "Mindster collected $4.77 from pot",
      "Mindster collected $4.77 from pot\nNo low hand qualified",
    );
    expect(parseStandardHand(forged, CTX)!.meta.warnings.map((warning) => warning.code)).toEqual([
      "hi-lo-half-mismatch",
    ]);
  });
});

describe("validation of the halves", () => {
  it("rejects a half on a hand that is not hi/lo", async () => {
    const subject = await hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    subject.game.hiLo = false;
    expect(validateHand(subject).errors.map((problem) => problem.code)).toContain(
      "stray-pot-half",
    );
  });

  it("flags halves that cannot both be half of the same pot", async () => {
    // Booking Aphily8's low quarter as high leaves $14.32 high against $4.77
    // low - the total still balances, which is exactly why this check exists.
    const subject = await hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    subject.actions.find((action) => action.player === "Aphily8" && action.type === "collect")!
      .half = "hi";
    expect(validateHand(subject).ok).toBe(true);
    expect(validateHand(subject).warnings.map((problem) => problem.code)).toContain(
      "hi-lo-halves-unbalanced",
    );
  });

  it("works the halves out again, and the same way, when asked twice", async () => {
    const subject = await hand("pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt");
    const before = halves(subject);
    expect(assignHiLoHalves(subject)).toEqual([]);
    expect(halves(subject)).toEqual(before);
  });
});

describe("the replayer", () => {
  function captions(subject: PhfHand, strings?: typeof replayerHr.frames): string[] {
    return buildReplay(subject, strings ? { strings } : {})
      .filter((frame) => frame.kind === "award")
      .map((frame) => frame.description);
  }

  it("pays the high half and the low half as separate beats", async () => {
    const subject = await hand("pokerstars/26-cash-nolimit-omahahilo.txt");
    expect(captions(subject)).toEqual([
      "High: Mindster wins $9.55",
      "Low: Aphily8 wins $4.78 · Mindster wins $4.77",
    ]);
    expect(captions(subject, replayerHr.frames)).toEqual([
      "Visoka ruka: Mindster osvaja $9.55",
      "Niska ruka: Aphily8 osvaja $4.78 · Mindster osvaja $4.77",
    ]);
  });

  it("names the pot as well when there is more than one, and keeps a split pot one pile", async () => {
    const subject = await hand("pokerstars/15-cash-omahahilo-limit-hi-lo-split.txt");
    const awards = buildReplay(subject).filter((frame) => frame.kind === "award");
    expect(awards.map((frame) => frame.description)).toEqual([
      "Main pot — High: Crazy Elior wins $2637.50",
      "Main pot — Low: LewisFriend wins $2637.50",
      "Side pot — High: Bluf_To_Much wins $2100",
      "Side pot — Low: LewisFriend wins $2100",
    ]);
    // After the main pot's high half is paid, its low half is still in the
    // middle with the side pot - one pile each, not three.
    expect(awards[0].pots.map((pot) => [pot.name, pot.amount])).toEqual([
      ["Main", 2637.5],
      ["Side", 4200],
    ]);
    expect(awards[awards.length - 1].pot).toBe(0);
  });

  it("says why nobody was paid low", async () => {
    const subject = await hand("pokerstars/17-cash-omahahilo-nolowqualified.txt");
    expect(captions(subject)).toEqual(["HELVER4728 wins $17.06 (no qualifying low)"]);
    expect(captions(subject, replayerHr.frames)).toEqual([
      "HELVER4728 osvaja $17.06 (nema kvalificirane niske ruke)",
    ]);
  });

  it("captions a pot nobody contested in the source's own decimals", async () => {
    const subject = await hand("pokerstars/14-cash-omahahilo-strange-names.txt");
    expect(captions(subject)).toEqual(["wo_ooly :D wins $2.50"]);
  });
});
