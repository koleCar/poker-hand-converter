import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import type { ConversionResult } from "../../frontend/src/lib/phf/detect.js";

/**
 * Every fixture in `test/fixtures/weplay/` exists because of a real broken hand
 * in the WePlay corpus. These assertions are the PHF-pipeline equivalents of
 * the ones in `supabaseConverter.test.ts`, which cover the same fixtures
 * through the legacy edge-function converter.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures/weplay", name), "utf8");
}

async function convert(
  name: string,
  options: Parameters<typeof convertAny>[1] = {},
): Promise<ConversionResult & { text: string; reasons: string[] }> {
  const result = await convertAny(fixture(name), {
    sourceFilename: name,
    cashOnly: true,
    skipBombPots: true,
    ...options,
  });
  return {
    ...result,
    text: result.hands.map((hand) => toStandardText(hand)).join("\n\n"),
    reasons: result.failures.map((failure) => failure.reason),
  };
}

describe("WePlay parser, hard-won edge cases", () => {
  it("normalizes the showdown token and strips UTC from the header", async () => {
    const result = await convert("tournament-sample.txt", { cashOnly: false });
    expect(result.text).toContain("*** SHOWDOWN ***");
    expect(result.text).not.toContain("*** SHOW DOWN ***");
    expect(result.text).not.toContain("UTC");
  });

  it("rewrites an SB open from chips-added to raise-over", async () => {
    const result = await convert("raise-sb-open.txt");
    expect(result.text).toContain("antananarivo: raises $2 to $3");
    expect(result.text).not.toContain("raises $2.50 to $3");
  });

  it("rewrites a button open to raise-over the current bet", async () => {
    const result = await convert("raise-button-open.txt");
    expect(result.text).toContain("antananarivo: raises $1.50 to $2.50");
    expect(result.text).not.toContain("raises $2.50 to $2.50");
  });

  it("rewrites a 3-bet chain with the right over amounts", async () => {
    const result = await convert("raise-3bet.txt");
    expect(result.text).toContain("Tone91: raises $1.50 to $2.50");
    expect(result.text).toContain("kole1992: raises $9.51 to $12.01");
    expect(result.text).not.toContain("raises $11.01 to $12.01");
  });

  it("rewrites a short covering all-in raise below the current bet to a call", async () => {
    const result = await convert("short-allin-raise-cover.txt");
    expect(result.hands).toHaveLength(1);
    expect(result.text).toContain("kole1992: calls $7.40 and is all-in");
    expect(result.text).not.toContain("raises $7.40 to $7.90");
  });

  it("rewrites hidden ## showdown cards to a muck", async () => {
    const result = await convert("hidden-showdown-cards.txt");
    expect(result.text).toContain("KratkiLucky: doesn't show hand");
    expect(result.text).not.toContain("##");
  });

  it("scrubs ## from SUMMARY showed lines", async () => {
    const result = await convert("summary-hidden-cards.txt");
    expect(result.hands).toHaveLength(1);
    expect(result.text).not.toContain("##");
    expect(result.text).toContain("LukasFlopovski (button) folded before Flop");
    expect(result.text).not.toMatch(/folded before Flop showed/);
    expect(result.text).toContain("petit_blaireau (small blind) showed [Jd Tc]");
  });

  it("strips phantom river boards on preflop walks", async () => {
    const result = await convert("phantom-river-walk.txt");
    expect(result.hands).toHaveLength(1);
    expect(result.text).not.toContain("*** RIVER ***");
    expect(result.text).not.toContain("Board [");
    expect(result.text).toContain("petike21 collected $2 from pot");
  });

  it("records a ghost ante as a failure rather than converting it", async () => {
    const result = await convert("ghost-ante.txt");
    expect(result.hands).toHaveLength(0);
    expect(result.reasons).toContain("ghost-ante");
  });

  it("records a zero-stack actor as a failure", async () => {
    const result = await convert("zero-stack-actor.txt");
    expect(result.hands).toHaveLength(0);
    expect(result.reasons).toContain("zero-stack-actor");
  });

  it("records a BB-only walk as a failure", async () => {
    const result = await convert("bb-only-walk.txt");
    expect(result.hands).toHaveLength(0);
    expect(result.reasons).toContain("bb-only-walk");
  });

  it("records a short all-in small blind as a failure", async () => {
    const result = await convert("short-sb-allin.txt");
    expect(result.hands).toHaveLength(0);
    expect(result.reasons).toContain("short-allin-small-blind");
  });

  it("keeps Omaha for a future parser instead of mangling it", async () => {
    const result = await convert("omaha-6card.txt");
    expect(result.hands).toHaveLength(0);
    expect(result.reasons).toContain("unsupported-variant");
    expect(result.failures[0].rawText).toContain("Weplay Hand #");
  });

  it("skips bomb pots on request but converts them by default", async () => {
    const skipped = await convert("bomb-pot-ante.txt");
    expect(skipped.hands).toHaveLength(0);
    expect(skipped.reasons).toContain("bomb-pot");

    const kept = await convert("bomb-pot-ante.txt", { skipBombPots: false });
    expect(kept.hands).toHaveLength(1);
    expect(kept.hands[0].game.bombPot).not.toBeNull();
    expect(kept.hands[0].game.anteModel).toBe("posted-per-player");
  });

  it("converts tournaments, with the level and buy-in parsed", async () => {
    const result = await convert("tournament-sample.txt", { cashOnly: false });
    expect(result.hands).toHaveLength(1);
    const hand = result.hands[0];
    expect(hand.game.format).toBe("tournament");
    expect(hand.game.unit.kind).toBe("chips");
    expect(hand.tournament?.id).toBeTruthy();
    expect(hand.tournament?.buyIn).toBeGreaterThan(0);
    expect(hand.tournament?.levelNumber).toBeGreaterThan(0);
  });

  it("parses a straddle into the pot math", async () => {
    const text = `Weplay Hand #90000001:  Hold'em No Limit ($1/$2) - 2026/01/03 22:12:42 UTC
Table 'Lisbon #1'(11485806) 6-max (Money 3) Seat #5 is the button
Seat 1: kole1992 ($200 in chips)
Seat 2: Kadiddy ($136.34 in chips)
Seat 3: UribnP ($221.17 in chips)
kole1992: posts small blind $1
Kadiddy: posts big blind $2
UribnP: posts straddle $4
*** HOLE CARDS ***
Dealt to kole1992 [Ad Js]
kole1992: raises $13 to $14
Kadiddy: folds
UribnP: folds
Uncalled bet ($10) returned to kole1992
*** SHOW DOWN ***
kole1992: doesn't show hand
kole1992 collected $10 from pot
*** SUMMARY ***
Total pot $10 | Rake $0
Seat 1: kole1992 (small blind) collected ($10)
Seat 2: Kadiddy (big blind) folded before Flop
Seat 3: UribnP folded before Flop`;
    const result = await convertAny(text, { sourceFilename: "straddle.txt" });
    expect(result.hands).toHaveLength(1);
    const hand = result.hands[0];
    expect(hand.game.straddles).toEqual([
      { seat: 3, player: "UribnP", amount: 400, order: 1 },
    ]);
    // The raise is reported over the straddle, not over the big blind.
    expect(toStandardText(hand)).toContain("kole1992: raises $10 to $14");
  });
});
