/**
 * Hands synced by the desktop app (docs/RAIL-PLAN.md R1.8, owner decision Q4)
 * are stored as PHF only: no `standard_text`, no `source_text`, and
 * `meta.rawText` empty. Every web reader that wants the text derives it with
 * `storedStandardText` (`lib/db/mapping.ts`): the owner's `getHand`, and both
 * share readers, whose PHF arrives redacted by `phf_redact_private` (the four
 * private `meta` keys removed, `rawText` among them).
 *
 * What has to hold, over the GG and sample corpora:
 *
 * - a web row's stored text is returned as it is, never re-rendered;
 * - a desktop row's text is `toStandardText` of its PHF, and reads back
 *   (`parseHand`, which the replayer and the share pages run) as a hand;
 * - the share's redacted PHF renders the same text as the owner's copy.
 */

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { storedStandardText, toHandRecord } from "../../frontend/src/lib/db/mapping.js";
import { convertAny } from "../../frontend/src/lib/parsers/index.js";
import { parseHand } from "../../frontend/src/lib/phf/index.js";
import { toStandardText } from "../../frontend/src/lib/phf/serialize.js";
import type { PhfHand } from "../../frontend/src/lib/phf/types.js";
import { ggCorpusFiles, readTree } from "./support/psggCorpus.js";

const ROOT = join(import.meta.dirname, "../..");
const FILES = [...ggCorpusFiles(), ...readTree(join(ROOT, "fixtures/samples"), "fixtures/samples")];

/** The PHF as the desktop sends it. */
function desktopShape(hand: PhfHand): PhfHand {
  return { ...hand, meta: { ...hand.meta, rawText: "" } };
}

/** What `phf_redact_private` leaves of it. */
function redacted(hand: PhfHand): unknown {
  const { rawText: _r, originalFilename: _o, warnings: _w, parsedAt: _p, ...meta } = hand.meta;
  return { ...hand, meta };
}

async function hands(): Promise<PhfHand[]> {
  const out: PhfHand[] = [];
  for (const file of FILES) {
    const result = await convertAny(file.text, { sourceFilename: file.name });
    out.push(...result.hands.map(desktopShape));
  }
  return out;
}

describe("desktop rows without standard text", () => {
  it("a stored text is returned as it is", () => {
    expect(storedStandardText("Poker Hand #1: stored", { meta: {} })).toBe("Poker Hand #1: stored");
    expect(storedStandardText(null, null)).toBe("");
    expect(storedStandardText(undefined, "not a hand")).toBe("");
  });

  it("derives the text from the PHF for the owner and for a share alike", async () => {
    const all = await hands();
    expect(all.length).toBeGreaterThan(500);
    for (const hand of all) {
      const expected = toStandardText(hand);
      const owner = toHandRecord({ id: "x", hand_key: "k", site: hand.meta.siteId, phf: hand, standard_text: null }).standardText;
      expect(owner).toBe(expected);
      expect(storedStandardText(null, redacted(hand))).toBe(expected);
      const back = parseHand(owner);
      expect(back?.meta.handId).toBe(hand.meta.handId);
      expect(back?.results.totalPot).toBe(hand.results.totalPot);
    }
  });
});
