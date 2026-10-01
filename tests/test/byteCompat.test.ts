import { describe, expect, it } from "vitest";

import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { splitStandardHands, toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import { convertCashWeplayFile as legacyConvert } from "./legacy/legacyConverter.js";
import { weplayFiles } from "./support/corpus.js";

/**
 * Byte compatibility with the pre-PHF converter.
 *
 * Holdem Manager and PokerTracker import the text this app produces, and they
 * are byte sensitive. `test/legacy/legacyConverter.ts` is a frozen copy of the
 * old implementation; every hand it emitted must still come out identical
 * unless the difference is one of the three reviewed cases below.
 *
 * ACCEPTED DIFFERENCES
 *
 * 1. `duplicate-hole-cards-block` - WePlay sometimes repeats
 *    `*** HOLE CARDS ***` and the `Dealt to` line *after* the showdown marker.
 *    The old converter passed the duplicate through, producing a malformed
 *    hand with two deal sections. The new pipeline emits each section once, in
 *    the canonical order. Same lines, correct order.
 *
 * 2. `straddle-raise-amount` - the old converter did not recognise
 *    `X: posts straddle $4`, so the straddle was missing from the pot math and
 *    the following `raises A to B` reported A as chips added rather than as the
 *    amount over the current bet. Both are now correct, which is also what
 *    fixed 47 hands the old converter emitted with an inconsistent pot.
 *
 * 3. `time-bank-line` - `X: activates time bank` is a UI event with no GG
 *    equivalent; it used to be copied into the output and is now dropped like
 *    every other non-poker line.
 */

type DiffClass = "duplicate-hole-cards-block" | "straddle-raise-amount" | "time-bank-line";

function classify(oldText: string, newText: string): DiffClass | null {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const onlyOld = a.filter((line) => !b.includes(line));
  const onlyNew = b.filter((line) => !a.includes(line));

  if (onlyOld.length === 0 && onlyNew.length === 0) {
    return "duplicate-hole-cards-block";
  }
  if (onlyOld.every((line) => /activates time bank/.test(line)) && onlyNew.length === 0) {
    return "time-bank-line";
  }
  if (
    /: posts straddle /.test(oldText) &&
    onlyOld.every((line) => /: raises /.test(line)) &&
    onlyNew.every((line) => /: raises /.test(line))
  ) {
    return "straddle-raise-amount";
  }
  return null;
}

function handsById(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of splitStandardHands(text)) {
    const id = chunk.split("\n")[0].match(/#(\S+):/)?.[1];
    if (id) {
      out.set(id, chunk);
    }
  }
  return out;
}

describe("standard text is byte compatible with the pre-PHF converter", () => {
  const files = weplayFiles();

  it("has something to compare", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  const totals = {
    legacyHands: 0,
    identical: 0,
    accepted: new Map<DiffClass, number>(),
    dropped: 0,
  };

  it.each(files.map((file) => [file.relativePath, file] as const))(
    "%s",
    async (_name, file) => {
      const legacy = legacyConvert(file.name, file.text);
      const expected =
        legacy.status === "converted" ? handsById(legacy.outputText) : new Map<string, string>();

      const result = await convertAny(file.text, {
        sourceFilename: file.name,
        cashOnly: true,
        skipBombPots: true,
      });
      const actual = new Map(result.hands.map((hand) => [hand.meta.handId, toStandardText(hand)]));

      totals.legacyHands += expected.size;
      const unexplained: string[] = [];

      for (const [id, text] of expected) {
        const fresh = actual.get(id);
        if (fresh === undefined) {
          // Dropped hands must be dropped for a stated reason, never silently.
          const failure = result.failures.find((entry) => entry.rawText.includes(id.slice(2)));
          if (!failure) {
            unexplained.push(`${id}: missing with no failure record`);
            continue;
          }
          totals.dropped += 1;
          continue;
        }
        if (fresh === text) {
          totals.identical += 1;
          continue;
        }
        const kind = classify(text, fresh);
        if (!kind) {
          unexplained.push(`${id}: unclassified difference`);
          continue;
        }
        totals.accepted.set(kind, (totals.accepted.get(kind) ?? 0) + 1);
      }

      expect(unexplained).toEqual([]);
    },
  );

  it("keeps the overwhelming majority byte identical", () => {
    expect(totals.legacyHands).toBeGreaterThan(5000);
    // Guards against the accepted-difference list quietly growing.
    expect(totals.identical / totals.legacyHands).toBeGreaterThan(0.96);
    expect(totals.dropped).toBeLessThan(5);
  });
});
