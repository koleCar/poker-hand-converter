import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import {
  parseStandardHand,
  splitStandardHands,
  toStandardText,
} from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { ggFiles, weplayFiles } from "./support/corpus.js";

const CTX = { siteId: "standard", siteName: "standard", originalFilename: null };

/**
 * The projection two semantically equal hands must agree on.
 *
 * Deliberately excludes `meta.parsedAt` (a wall clock) and `meta.rawText` (the
 * WePlay original on one side, our own text on the other). Everything that
 * describes the *hand* is compared.
 */
function semantics(hand: PhfHand) {
  return {
    schema: hand.schema,
    handId: hand.meta.handId,
    playedAt: hand.playedAt,
    game: hand.game,
    table: hand.table,
    tournament: hand.tournament,
    players: hand.players,
    board: hand.board,
    results: hand.results,
    textStyle: hand.meta.textStyle,
    actions: hand.actions.map((action) => ({
      street: action.street,
      runoutIndex: action.runoutIndex,
      player: action.player,
      type: action.type,
      amount: action.amount,
      streetTotal: action.streetTotal,
      allIn: action.allIn,
      cards: action.cards ?? null,
      description: action.description ?? null,
      potName: action.potName ?? null,
    })),
  };
}

describe("standard text -> PHF -> standard text", () => {
  const files = ggFiles();

  it("finds the reference corpus", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((file) => [file.relativePath, file] as const))(
    "%s parses every hand with no unknown lines",
    (_name, file) => {
      const chunks = splitStandardHands(file.text);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        const hand = parseStandardHand(chunk, CTX);
        expect(hand, chunk.split("\n")[0]).not.toBeNull();
        expect(hand!.meta.warnings, chunk.split("\n")[0]).toEqual([]);
      }
    },
  );

  it.each(files.map((file) => [file.relativePath, file] as const))(
    "%s re-serializes byte for byte",
    (_name, file) => {
      for (const chunk of splitStandardHands(file.text)) {
        const hand = parseStandardHand(chunk, CTX)!;
        expect(toStandardText(hand)).toBe(chunk);
      }
    },
  );

  it.each(files.map((file) => [file.relativePath, file] as const))(
    "%s survives a parse -> serialize -> parse round trip unchanged",
    (_name, file) => {
      for (const chunk of splitStandardHands(file.text)) {
        const first = parseStandardHand(chunk, CTX)!;
        const second = parseStandardHand(toStandardText(first), CTX)!;
        expect(semantics(second)).toEqual(semantics(first));
      }
    },
  );
});

describe("WePlay -> PHF -> standard text", () => {
  const files = weplayFiles();

  it("finds the WePlay corpus", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((file) => [file.relativePath, file] as const))(
    "%s round-trips every converted hand",
    async (_name, file) => {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      expect(result.stats.total).toBeGreaterThan(0);

      for (const hand of result.hands) {
        const text = toStandardText(hand);
        const reparsed = parseStandardHand(text, CTX)!;
        expect(reparsed, text.split("\n")[0]).not.toBeNull();
        // No information is lost on the way out and back in.
        expect(toStandardText(reparsed)).toBe(text);
        expect(reparsed.meta.warnings).toEqual([]);
      }
    },
  );
});

describe("conversion coverage", () => {
  it("converts the overwhelming majority of the WePlay corpus", async () => {
    let total = 0;
    let converted = 0;
    for (const file of weplayFiles()) {
      const result = await convertAny(file.text, { sourceFilename: file.name });
      total += result.stats.total;
      converted += result.stats.converted;
    }
    expect(total).toBeGreaterThan(6000);
    // Tournaments and bomb pots are converted now, so the bar is high; what is
    // left over is genuinely broken source data.
    expect(converted / total).toBeGreaterThan(0.98);
  });
});
