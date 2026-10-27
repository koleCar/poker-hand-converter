/**
 * The statistics oracle (docs/RAIL-PLAN.md R2.1).
 *
 * For every hand of every golden, the rows the TypeScript stats engine
 * derives - `statsRows(handFacts(hand))`, one per dealt-in seat, hero and
 * villains alike - in the canonical JSON of `canonical.ts`. `rail-stats` is
 * correct for a hand when its rows are these bytes.
 *
 * Two trees, the same split as the PHF goldens (`testdata/golden/README.md`):
 *
 * - `testdata/golden-stats/<input>.json` - committed. Per hand the sha-256 of
 *   the canonical rows and the seats they are for, plus per file the sum of
 *   every counter and money column, so a change of meaning shows up in review
 *   as "this counter moved in these files".
 * - `testdata/golden-stats-full/<input>.json` - gitignored. The same document
 *   with every row written out.
 *
 * The rows are derived from the hand **as the golden stores it**: the PHF's
 * canonical JSON, parsed back. That is exactly the document the Rust test
 * reads from `testdata/golden-full/`, so both engines see the same input, and
 * `handFacts` (which may call `assignPositions`, which mutates) never touches
 * the pipeline's own objects.
 *
 * One normalisation: `-0` is written as `0`. `net_bb_milli` rounds half away
 * from zero as `-Math.round(-x)`, so a loss of less than half a thousandth of
 * a big blind comes out as `-0` (and a negative fee total can make a
 * `rake_paid` share `-0`). Every consumer of a row reads that as 0 -
 * `JSON.stringify(-0)` is `"0"`, and the column is a Postgres integer - and an
 * integer in Rust has no `-0`. The count is reported by the emitter.
 */

import { createHash } from "node:crypto";

import { handFacts } from "../../../web/src/lib/stats/derive.js";
import { statsRows, type StatsRow } from "../../../web/src/lib/stats/mapping.js";
import { COUNTER_KEYS, MONEY_KEYS, STATS_VERSION } from "../../../web/src/lib/stats/types.js";
import { canonicalJson } from "./canonical.js";

/** Bumped whenever the shape of a stats golden changes. */
export const STATS_GOLDEN_FORMAT = "rail-stats-golden/1";

/** One accepted hand of a golden, as the PHF golden pins it. */
export interface GoldenHandInput {
  index: number;
  handId: string;
  /** `canonicalJson(phf)` - the bytes `testdata/golden-full/` holds. */
  phfText: string;
}

export interface StatsGoldenFile {
  summary: Record<string, unknown>;
  full: Record<string, unknown>;
  rows: number;
  /** `-0`s written as `0` (see the file header). */
  negativeZeros: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `row` with every `-0` replaced by `0`; counts the replacements. */
function withoutNegativeZero(row: StatsRow, count: { n: number }): StatsRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (Object.is(value, -0)) {
      count.n += 1;
      out[key] = 0;
    } else {
      out[key] = value;
    }
  }
  return out as StatsRow;
}

/** The stats goldens for one input file, given the hands its PHF golden holds. */
export function statsGoldenFor(
  path: string,
  input: Record<string, unknown>,
  hands: GoldenHandInput[],
): StatsGoldenFile {
  const negativeZeros = { n: 0 };
  const totals = new Map<string, number>();
  const summaryHands: Record<string, unknown>[] = [];
  const fullHands: Record<string, unknown>[] = [];
  let rowCount = 0;

  for (const hand of hands) {
    const phf = JSON.parse(hand.phfText);
    const rows = statsRows(handFacts(phf)).map((row) => withoutNegativeZero(row, negativeZeros));
    let text: string;
    try {
      text = canonicalJson(rows);
    } catch (error) {
      throw new Error(
        `${path} hand ${hand.index}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const row of rows) {
      for (const key of [...COUNTER_KEYS, ...MONEY_KEYS]) {
        totals.set(key, (totals.get(key) ?? 0) + (row[key] as number));
      }
    }
    rowCount += rows.length;
    const common = {
      index: hand.index,
      handId: hand.handId,
      phf: sha256(hand.phfText),
      seats: rows.map((row) => row.seat),
    };
    summaryHands.push({ ...common, rows: sha256(text) });
    fullHands.push({ ...common, rows });
  }

  // Zero sums are left out: most files never see a five-bet.
  const totalsDoc: Record<string, number> = {};
  for (const [key, value] of totals) {
    if (value !== 0) {
      totalsDoc[key] = value;
    }
  }
  const rest = {
    format: STATS_GOLDEN_FORMAT,
    input,
    statsVersion: STATS_VERSION,
    rows: rowCount,
    totals: totalsDoc,
  };
  return {
    summary: { ...rest, hands: summaryHands },
    full: { ...rest, hands: fullHands },
    rows: rowCount,
    negativeZeros: negativeZeros.n,
  };
}
