/**
 * The Analytics checker rows on the web (docs/ANALYTICS.md Step 2): derived
 * from the hand and its stored decisions (`lib/stats/analyticsRows.ts`),
 * written by `analytics_rows_save`, summed by `analytics_checker`
 * (`20271122090000_analytics_checker_rows.sql`).
 *
 * - **Written with the analysis**: `runAnalysis` derives a slice's rows from
 *   the hands it just analysed and saves them after `save_hand_analysis`
 *   ({@link saveRowsOfAnalysed}). A failure there does not stop the
 *   analysis: the new analysis queued the hand on the server
 *   (`derive_queue`, docs/POOL.md P1), whose one pass writes the rows.
 *   Hands analysed before the checker existed (or at another catalogue
 *   version) are queued by the rollout, not walked by a page.
 * - **Reads**: {@link checkerSource} (`CheckerSource` of `@rail/ui`).
 */

import type {
  CheckerExample,
  CheckerExampleQuery,
  CheckerFilters,
  CheckerGroup,
  CheckerSource,
  CheckerSums,
} from "@rail/ui/analytics/model";

import { ANALYSIS_VERSION } from "../analysis";
import type { PhfHand } from "../phf/types";
import { ANALYTICS_MEMBERSHIP_VERSION } from "../stats/analytics";
import type { RowsDecisionIn } from "../stats/analyticsRows";
import { analyticsRowsHand, type AnalyticsRowsHand } from "../derive/onePass";
import { rpc } from "./client";

export { analyticsRowsHand, type AnalyticsRowsHand };

/** Hands per `analytics_rows_save` call (it takes 200). */
const SAVE_SIZE = 100;

/** Saves hands' rows, a slice at a time. How many hands were saved. */
export async function saveAnalyticsRows(hands: readonly AnalyticsRowsHand[]): Promise<number> {
  let saved = 0;
  for (let i = 0; i < hands.length; i += SAVE_SIZE) {
    const result = await rpc<{ saved?: number } | null>("analytics_rows_save", { p_hands: hands.slice(i, i + SAVE_SIZE) });
    saved += result?.saved ?? 0;
  }
  return saved;
}

/** A hand the analysis just saved: its id, version, PHF and decisions (`HandAnalysisInsert`). */
export interface AnalysedHand {
  hand_id: string;
  analysis_version: string;
  decisions: readonly RowsDecisionIn[];
}

let warned = false;

/**
 * The rows of hands `runAnalysis` just saved, saved in turn. Never throws: a
 * hand whose rows are not written stays in the server's queue.
 */
export async function saveRowsOfAnalysed(
  analysed: readonly AnalysedHand[],
  phfOf: (handId: string) => PhfHand | undefined,
): Promise<number> {
  try {
    const hands: AnalyticsRowsHand[] = [];
    for (const row of analysed) {
      const phf = phfOf(row.hand_id);
      if (phf) hands.push(analyticsRowsHand(row.hand_id, row.analysis_version, phf, row.decisions));
    }
    return await saveAnalyticsRows(hands);
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("Analytics rows were not saved; the server will write them.", error);
    }
    return 0;
  }
}

/* ---------------------------------------------------------------- reads - */

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

type Row = Record<string, unknown>;

function groupOf(row: Row): CheckerGroup {
  return {
    stat: str(row.stat),
    spot: str(row.spot),
    size: str(row.size),
    handClass: str(row.handClass),
    opps: num(row.opps),
    oppsTaken: num(row.oppsTaken),
    n: num(row.n),
    taken: num(row.taken),
    refShare: num(row.refShare),
    evHigh: num(row.evHigh),
    evLow: num(row.evLow),
    hands: num(row.hands),
  };
}

function exampleOf(row: Row): CheckerExample {
  return {
    handId: str(row.handId),
    ord: num(row.ord),
    actionIndex: num(row.actionIndex),
    playedAt: typeof row.playedAt === "string" ? row.playedAt : null,
    site: str(row.site),
    stat: str(row.stat),
    spot: str(row.spot),
    size: str(row.size),
    handClass: str(row.handClass),
    taken: row.taken === true,
    bestIn: row.bestIn === true,
    refShare: num(row.refShare),
    evLossBb: num(row.evLossBb),
    facingPot: typeof row.facingPot === "number" ? row.facingPot : null,
    cards: strings(row.cards),
    board: strings(row.board),
  };
}

function filtersOf(filters: CheckerFilters): Record<string, unknown> {
  return {
    analysisVersion: ANALYSIS_VERSION,
    membershipVersion: ANALYTICS_MEMBERSHIP_VERSION,
    ...filters,
  };
}

/** The checker's grouped sums (`analytics_checker`). */
export async function fetchChecker(filters: CheckerFilters = {}): Promise<CheckerSums | null> {
  const data = await rpc<Row | null>("analytics_checker", { p_filters: filtersOf(filters) });
  if (!data) return null;
  return {
    analysisVersion: str(data.analysisVersion),
    membershipVersion: str(data.membershipVersion),
    hands: num(data.hands),
    pending: num(data.pending),
    groups: (Array.isArray(data.groups) ? (data.groups as Row[]) : []).map(groupOf),
  };
}

/** The costliest decisions of one stat (`analytics_checker_examples`). */
export async function fetchCheckerExamples(
  filters: CheckerFilters,
  query: CheckerExampleQuery,
): Promise<CheckerExample[]> {
  const data = await rpc<{ rows?: Row[] } | null>("analytics_checker_examples", {
    p_filters: filtersOf(filters),
    p_stat: query.stat,
    p_spot: query.spot ?? undefined,
    p_size: query.size ?? undefined,
    p_hand_class: query.handClass ?? undefined,
    p_side: query.side ?? "high",
    p_limit: query.limit ?? 20,
  });
  return (data?.rows ?? []).map(exampleOf);
}

/** The web's `CheckerSource`. */
export const checkerSource: CheckerSource = {
  checker: fetchChecker,
  examples: fetchCheckerExamples,
};
