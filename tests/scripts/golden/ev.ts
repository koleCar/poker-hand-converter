/**
 * The all-in EV oracle (docs/RAIL-PLAN.md R2.2).
 *
 * For every hand of every golden, what the TypeScript EV engine concludes:
 *
 * - `row` - the hero's `hand_stats_ev` row exactly as the web writes it:
 *   `handEvRow(hand, hero)` with `hero` the first hero row of
 *   `handStatsRows(hand)` (`app/api/stats/rebuild/route.ts`). A hand without
 *   a hero gets no row (`null`), as on the web. Every hand with a hero has
 *   one, `applicable: false` included (`ev_net = net`).
 * - `analysis` - `analyzeAllIn(hand)` with the default options (the ones
 *   stored rows use): the skip reason and detail, or the street, board,
 *   method, pots (amounts, eligible seats, equities, shares) and every seat's
 *   `evNet`.
 *
 * Equities are doubles, and canonical JSON refuses floats, so each is
 * written as `String(x)`: the shortest decimal that reads back as exactly
 * that double, which Rust prints the same way (`JsNumber::to_js_string`).
 * Equal strings are equal doubles.
 *
 * Two trees, the split of the PHF and stats goldens:
 *
 * - `testdata/golden-ev/<input>.json` - committed. Per hand the hero's row
 *   and the analysis as sha-256 hashes, plus the skip reason in clear; per
 *   file the counts per outcome and the row columns summed, so a change of
 *   meaning shows up in review as "ev_net moved in these files".
 * - `testdata/golden-ev-full/<input>.json` - gitignored. The same with the
 *   rows and analyses written out.
 *
 * Derived, like the stats goldens, from the hand as the golden stores it (its
 * canonical JSON parsed back), a fresh copy per engine call: `handStatsRows`
 * may write positions into its input.
 */

import { createHash } from "node:crypto";

import { handEvRow, handStatsRows } from "../../../frontend/src/lib/db/statsRows.js";
import { EV_VERSION, analyzeAllIn, type AllInEvOutcome } from "../../../frontend/src/lib/equity/index.js";
import { canonicalJson } from "./canonical.js";
import type { GoldenHandInput } from "./stats.js";

/** Bumped whenever the shape of an EV golden changes. */
export const EV_GOLDEN_FORMAT = "rail-ev-golden/1";

export interface EvGoldenFile {
  summary: Record<string, unknown>;
  full: Record<string, unknown>;
  /** Hands with an EV row (hands with a hero). */
  rows: number;
  /** Rows with `applicable: true`. */
  applicable: number;
  /** Analyses (every hand) that sampled rather than enumerated. */
  monteCarlo: number;
  /** Applicable analyses of short-deck hands. */
  shortDeck: number;
  /** Hands the engine declined as hi/lo. */
  hiLo: number;
  /** `-0`s written as `0` (`ev_net_bb_milli` of a loss under half a milli-blind). */
  negativeZeros: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The analysis as the golden stores it: every equity as `String(x)`. */
export function analysisDoc(outcome: AllInEvOutcome): Record<string, unknown> {
  if (!outcome.applicable) {
    return { applicable: false, reason: outcome.reason, detail: outcome.detail };
  }
  const { ev } = outcome;
  return {
    applicable: true,
    evVersion: ev.evVersion,
    street: ev.street,
    actionIndex: ev.actionIndex,
    board: ev.board,
    method: ev.method,
    boards: ev.boards,
    pots: ev.pots.map((pot) => ({
      amount: pot.amount,
      gross: pot.gross,
      eligibleSeats: pot.eligibleSeats,
      equity: pot.equity.map((value) => String(value)),
      shares: pot.shares,
    })),
    seats: ev.seats.map((seat) => ({
      seat: seat.seat,
      player: seat.player,
      live: seat.live,
      contributed: seat.contributed,
      evWon: seat.evWon,
      evNet: seat.evNet,
    })),
  };
}

/** The EV goldens for one input file, given the hands its PHF golden holds. */
export function evGoldenFor(
  path: string,
  input: Record<string, unknown>,
  hands: GoldenHandInput[],
): EvGoldenFile {
  const counts = { rows: 0, applicable: 0, monteCarlo: 0, shortDeck: 0, hiLo: 0, negativeZeros: 0 };
  const outcomes = new Map<string, number>();
  const totals = { ev_net: 0, ev_net_bb_milli: 0 };
  const summaryHands: Record<string, unknown>[] = [];
  const fullHands: Record<string, unknown>[] = [];

  for (const hand of hands) {
    const where = `${path} hand ${hand.index}`;
    const outcome = analyzeAllIn(JSON.parse(hand.phfText));
    const analysis = analysisDoc(outcome);

    const phf = JSON.parse(hand.phfText);
    const hero = handStatsRows(phf, { includeVillains: false }).find((row) => row.is_hero);
    let row: Record<string, unknown> | null = null;
    if (hero) {
      row = { ...handEvRow(phf, hero) };
      for (const key of ["ev_net", "ev_net_bb_milli"]) {
        if (Object.is(row[key], -0)) {
          row[key] = 0;
          counts.negativeZeros += 1;
        }
      }
      counts.rows += 1;
      if (row.applicable) counts.applicable += 1;
      totals.ev_net += row.ev_net as number;
      totals.ev_net_bb_milli += row.ev_net_bb_milli as number;
    }

    const key = outcome.applicable ? `applicable/${outcome.ev.method}` : outcome.reason;
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    if (outcome.applicable && outcome.ev.method === "monte-carlo") counts.monteCarlo += 1;
    if (outcome.applicable && phf.game.variant === "shortdeck") counts.shortDeck += 1;
    if (!outcome.applicable && outcome.reason === "hi-lo") counts.hiLo += 1;

    let rowText: string | null;
    let analysisText: string;
    try {
      rowText = row === null ? null : canonicalJson(row);
      analysisText = canonicalJson(analysis);
    } catch (error) {
      throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const common = {
      index: hand.index,
      handId: hand.handId,
      phf: sha256(hand.phfText),
      reason: outcome.applicable ? null : outcome.reason,
    };
    summaryHands.push({
      ...common,
      row: rowText === null ? null : sha256(rowText),
      analysis: sha256(analysisText),
    });
    fullHands.push({ ...common, row, analysis });
  }

  const rest = {
    format: EV_GOLDEN_FORMAT,
    input,
    evVersion: EV_VERSION,
    rows: counts.rows,
    outcomes: Object.fromEntries([...outcomes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    totals,
  };
  return {
    summary: { ...rest, hands: summaryHands },
    full: { ...rest, hands: fullHands },
    ...counts,
  };
}
