/**
 * The Analytics checker rows on the web (docs/ANALYTICS.md Step 2): derived
 * in the browser (`lib/stats/analyticsRows.ts`, from the hand and its stored
 * decisions), written by `analytics_rows_save`, summed by
 * `analytics_checker` (`20271122090000_analytics_checker_rows.sql`).
 *
 * - **Written with the analysis**: `runAnalysis` derives a slice's rows from
 *   the hands it just analysed and saves them after `save_hand_analysis`
 *   ({@link saveRowsOfAnalysed}). A failure there does not stop the
 *   analysis: the hands stay on the backfill's work list.
 * - **Backfill** ({@link backfillAnalyticsRows}): the hands analysed at the
 *   current version without rows at the current membership version
 *   (`analytics_rows_pending`, a keyset page at a time: never analysed with
 *   rows, or written at another version), each parsed back from its stored
 *   row and derived from its stored decisions - no re-analysis. Idempotent:
 *   a hand's rows are replaced, and a page's hands leave the list.
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
import { analyticsRows, type RowsDecisionIn } from "../stats/analyticsRows";
import { rpc } from "./client";
import { handOfRow, type StoredHandRow } from "./storedHand";

/** Hands per `analytics_rows_save` call (it takes 200). */
const SAVE_SIZE = 100;

/** Hands per backfill page (`analytics_rows_pending` returns 200 at most). */
const BACKFILL_PAGE = 100;

/** One hand as `analytics_rows_save` takes it. */
export interface AnalyticsRowsHand {
  hand_id: string;
  analysis_version: string;
  membership_version: string;
  rows: Array<{
    ord: number;
    stat: string;
    taken: boolean;
    ref_share: number | null;
    best_in: boolean | null;
    size: string;
    hand_class: string;
    spot: string;
    multiway: boolean;
  }>;
}

/** A hand's rows in the writer's shape. */
export function analyticsRowsHand(
  handId: string,
  analysisVersion: string,
  hand: PhfHand,
  decisions: readonly RowsDecisionIn[],
): AnalyticsRowsHand {
  return {
    hand_id: handId,
    analysis_version: analysisVersion,
    membership_version: ANALYTICS_MEMBERSHIP_VERSION,
    rows: analyticsRows(hand, decisions).map((row) => ({
      ord: row.ord,
      stat: row.stat,
      taken: row.taken,
      ref_share: row.refShare,
      best_in: row.bestIn,
      size: row.size,
      hand_class: row.handClass,
      spot: row.spot,
      multiway: row.multiway,
    })),
  };
}

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
 * hand whose rows are not written stays on the backfill's work list.
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
      console.warn("Analytics rows were not saved; the backfill will write them.", error);
    }
    return 0;
  }
}

export interface BackfillProgress {
  /** Hands read from the work list. */
  processed: number;
  /** Hands whose rows were saved. */
  saved: number;
}

type PendingRow = StoredHandRow & { id: string; decisions: RowsDecisionIn[] | null };

/**
 * Writes the rows of every hand analysed at `ANALYSIS_VERSION` that has none
 * at `ANALYTICS_MEMBERSHIP_VERSION`, a page at a time, until the list is
 * walked or `signal` stops it. Safe to run twice at once and to interrupt.
 */
export async function backfillAnalyticsRows(
  signal?: AbortSignal,
  onProgress?: (progress: BackfillProgress) => void,
): Promise<BackfillProgress> {
  const total: BackfillProgress = { processed: 0, saved: 0 };
  const fetchPage = async (after: string | null): Promise<PendingRow[]> =>
    (await rpc<PendingRow[] | null>("analytics_rows_pending", {
      p_analysis_version: ANALYSIS_VERSION,
      p_membership_version: ANALYTICS_MEMBERSHIP_VERSION,
      p_after: after ?? undefined,
      p_limit: BACKFILL_PAGE,
    })) ?? [];
  let next: Promise<PendingRow[]> | null = fetchPage(null);
  // Bounded so a server that never runs dry cannot spin a tab forever.
  for (let guard = 0; next !== null && guard < 100_000 && !signal?.aborted; guard += 1) {
    const page: PendingRow[] = await next;
    if (page.length === 0) break;
    // The next page is on its way while this one is read and saved (keyset
    // order: this page's rows are never in it).
    next = page.length < BACKFILL_PAGE ? null : fetchPage(page[page.length - 1].id);
    const read = await Promise.all(page.map((row) => handOfRow(row)));
    const hands: AnalyticsRowsHand[] = [];
    page.forEach((row, index) => {
      // A text this build cannot read back stays on the list for a later build.
      const phf = read[index];
      if (phf) hands.push(analyticsRowsHand(row.id, ANALYSIS_VERSION, phf, row.decisions ?? []));
    });
    if (signal?.aborted) break;
    total.saved += await saveAnalyticsRows(hands);
    total.processed += page.length;
    onProgress?.({ ...total });
  }
  // A page fetched ahead and not needed (stopped): nothing waits on it.
  next?.catch(() => undefined);
  return total;
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
