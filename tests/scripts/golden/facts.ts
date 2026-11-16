/**
 * The filter builder's facts oracle (2026-11-16): for every hand of every
 * golden, what the web's `builderFacts` derives - the hero's sizes, made
 * hands, kickers, draws, the opponents in the pot, position on the flop, the
 * tournament's buy-in, bounty and level, who was caught bluffing.
 *
 * `testdata/golden-facts/<input>.json` - committed, one entry per hand.
 * `core/rail-store/tests/facts_corpus.rs` derives the desktop's facts
 * (`facts::derive`) from the same hands (`testdata/golden-full/`) and
 * compares field by field, so the web's builder filters mean the app's.
 *
 * The rows are the ones the desktop keeps (`keptRows`: the hero's and the
 * villains', none of a positionally anonymised room), derived from the hand
 * as the golden stores it.
 */

import { detectAnonymization } from "../../../web/src/lib/db/anonymization.js";
import { builderFacts, keptRows } from "../../../web/src/lib/stats/builderFacts.js";
import { handFacts } from "../../../web/src/lib/stats/derive.js";
import { statsRows } from "../../../web/src/lib/stats/mapping.js";
import type { GoldenHandInput } from "./stats.js";

/** Bumped whenever the shape of a facts golden changes. */
export const FACTS_GOLDEN_FORMAT = "rail-facts-golden/1";

export function factsGoldenFor(input: string, hands: GoldenHandInput[]): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  for (const hand of hands) {
    const phf = JSON.parse(hand.phfText);
    const rows = keptRows(statsRows(handFacts(JSON.parse(hand.phfText))), detectAnonymization(phf) === "positional");
    out.push({ index: hand.index, handId: hand.handId, facts: builderFacts(phf, rows) });
  }
  return { format: FACTS_GOLDEN_FORMAT, input, hands: out };
}
