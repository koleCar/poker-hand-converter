/**
 * `potType` (stats/2) over the WePlay and GG corpus: every hand gets exactly one
 * kind, and the kind agrees with the counters derived from the same hand — a
 * 3-bet made by anybody means the pot is at least a 3-bet pot, a walk is a
 * walk, a bomb pot is a bomb pot.
 */
import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { handFacts } from "../../frontend/src/lib/stats/derive.js";
import { weplayFiles } from "./support/corpus.js";
import { ggCorpusFiles } from "./support/psggCorpus.js";

const KINDS = new Set(["walk", "bomb", "limped", "single-raised", "3bet", "4bet+"]);

describe("potType", async () => {
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  for (const file of [...weplayFiles(), ...ggCorpusFiles()]) {
    const { hands } = await convertAny(file.text, { sourceFilename: file.name });
    for (const hand of hands) {
      const facts = handFacts(hand);
      const kind = facts.hand.potType;
      counts[kind] = (counts[kind] ?? 0) + 1;
      const anyThreeBet = facts.seats.some((seat) => seat.counters.three_bet > 0);
      const anyFourBet = facts.seats.some((seat) => seat.counters.four_bet > 0);
      if (!KINDS.has(kind)) problems.push(`${file.relativePath} ${hand.meta.handId}: unknown ${kind}`);
      if (facts.hand.isWalk !== (kind === "walk")) problems.push(`${hand.meta.handId}: walk mismatch`);
      if (facts.hand.isBombPot !== (kind === "bomb")) problems.push(`${hand.meta.handId}: bomb mismatch`);
      if (anyThreeBet && kind !== "3bet" && kind !== "4bet+") problems.push(`${hand.meta.handId}: 3-bet but ${kind}`);
      if (anyFourBet && kind !== "4bet+") problems.push(`${hand.meta.handId}: 4-bet but ${kind}`);
    }
  }

  it("gives every hand one kind that agrees with its counters", () => {
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it("sees every kind in a corpus this size", () => {
    for (const kind of ["walk", "limped", "single-raised", "3bet", "4bet+", "bomb"]) {
      expect(counts[kind] ?? 0, kind).toBeGreaterThan(0);
    }
  });
});
