/**
 * The database side of hand analysis: the in-browser rebuild and the reports.
 *
 * `lib/analysis` decides what a decision was and why; it may import nothing
 * that knows about Supabase. Everything that does lives here, in the same
 * split `stats.ts` makes for statistics:
 *
 *   * **Semantics** in `lib/analysis` — facts, flags, the grading rules.
 *   * **Arithmetic** in SQL — `20261228090000_analysis.sql`, counts and means.
 *   * **The wire** here, and in `analysisRows.ts` for the pure half.
 *
 * ## Why the rebuild runs in the browser
 *
 * The plan's decision (§5, §8.3): no worker host, and Vercel's function limit is
 * far below what the later solver phases need. The page is fetched as the user
 * (`hands_needing_analysis`, invoker), analysed in a Web Worker
 * (`workers/analysis.worker.ts`) and written as the user (`save_hand_analysis`,
 * definer with an explicit ownership check). "Missing" is computed by the
 * database, so the run is resumable for free: close the tab half way and the
 * next run picks up whatever is still missing.
 */

import { ANALYSIS_VERSION, type HandAnalysis } from "../analysis";
import type { PhfHand } from "../phf/types";
import { currentUserId, rpc } from "./client";
import {
  analyseStoredHands,
  handAnalysisFromStored,
  type AnalysedBatch,
  type HandAnalysisInsert,
} from "./analysisRows";
import type { AnalyseRequest, AnalysisWorkerResponse } from "../../workers/analysis.worker";

export { handAnalysisFromStored } from "./analysisRows";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const maybeNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/* --------------------------------------------------------------- filters - */

/**
 * The filters every report accepts. All optional, all bound server-side.
 * `analysisVersion` is filled in by {@link withVersion}; callers never set it.
 */
export interface AnalysisFilters {
  analysisVersion?: string;
  from?: string;
  to?: string;
  site?: string;
  gameFormat?: string;
  currency?: string;
  bigBlind?: number;
  position?: string;
  potType?: string;
  status?: string;
  street?: string;
  flag?: string;
  flagged?: boolean;
}

/**
 * Every report reads one `analysis_version`, and the server's default for a
 * caller that does not say is the first one. So the client always says: a
 * version bump would otherwise rebuild every library and then keep reading the
 * rows it had just made obsolete. The same rule as `withVersion` in `stats.ts`.
 */
function withVersion(filters: AnalysisFilters): AnalysisFilters {
  return { analysisVersion: ANALYSIS_VERSION, ...filters };
}

/* -------------------------------------------------------------- coverage - */

export interface AnalysisCoverage {
  analysisVersion: string;
  hands: number;
  atVersion: number;
  /** Analysed only under an older version: the version changed since. */
  stale: number;
  /** Never analysed. */
  missing: number;
  obsoleteRows: number;
}

export async function fetchAnalysisCoverage(): Promise<AnalysisCoverage | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_coverage", { p_version: ANALYSIS_VERSION });
  if (!payload) {
    return null;
  }
  return {
    analysisVersion: str(payload.analysisVersion) ?? ANALYSIS_VERSION,
    hands: num(payload.hands),
    atVersion: num(payload.atVersion),
    stale: num(payload.stale),
    missing: num(payload.missing),
    obsoleteRows: num(payload.obsoleteRows),
  };
}

/* --------------------------------------------------------------- rebuild - */

export interface AnalysisProgress {
  /** Hands read and analysed. */
  processed: number;
  /** Hand rows written. */
  saved: number;
  /** Hands the engine could not read. */
  failed: number;
  /** Obsolete rows removed at the end. */
  pruned: number;
}

/** Hands per read; `hands_needing_analysis` caps at 200. */
const PAGE_SIZE = 100;
/** Hands per write: `save_hand_analysis` takes 200, and a hand's facts are ~1–4 KB. */
const WRITE_SIZE = 50;
const MAX_PRUNE_CALLS = 10;

let jobSequence = 0;

/**
 * Analyses one page off the main thread, or on it when a worker cannot be
 * created (a strict CSP, an embedded webview) — slower and janky, but a screen
 * that silently never finishes would be worse.
 */
function analyser(): { run: (page: AnalyseRequest["page"]) => Promise<AnalysedBatch>; close: () => void } {
  let worker: Worker | null = null;
  try {
    worker = new Worker(new URL("../../workers/analysis.worker.ts", import.meta.url), {
      type: "module",
      name: "rail-analysis",
    });
  } catch {
    worker = null;
  }
  if (!worker) {
    return {
      run: async (page) => {
        // Yield first so the progress line repaints between pages.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return analyseStoredHands(page);
      },
      close: () => {},
    };
  }
  const live = worker;
  return {
    run: (page) =>
      new Promise<AnalysedBatch>((resolve, reject) => {
        jobSequence += 1;
        const jobId = jobSequence;
        live.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
          const message = event.data;
          if (message.jobId !== jobId) return;
          if (message.type === "analysed") resolve({ rows: message.rows, failed: message.failed });
          else reject(new Error(message.message));
        };
        live.onerror = (event) => reject(new Error(event.message || "analysis worker failed"));
        live.postMessage({ type: "analyse", jobId, page } satisfies AnalyseRequest);
      }),
    close: () => live.terminate(),
  };
}

/**
 * Analyses every hand of the caller's that has no row at the current
 * `ANALYSIS_VERSION`, then prunes rows from older versions.
 *
 * Safe to run twice at once and safe to interrupt: every write is
 * `on conflict do nothing` and what is missing is recomputed per page.
 * `signal` stops it between pages.
 */
export async function runAnalysis(
  onProgress?: (progress: AnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AnalysisProgress> {
  const total: AnalysisProgress = { processed: 0, saved: 0, failed: 0, pruned: 0 };
  if (!(await currentUserId())) {
    return total;
  }
  const engine = analyser();
  let after: string | null = null;
  let done = false;
  try {
    // Bounded so a server that never runs dry cannot spin a tab forever:
    // 5,000 pages of 100 is far beyond any library this app could hold.
    for (let page = 0; page < 5000 && !signal?.aborted; page += 1) {
      const fetched: Array<{ id: string; phf: PhfHand }> | null = await rpc("hands_needing_analysis", {
        p_version: ANALYSIS_VERSION,
        p_after: after ?? undefined,
        p_limit: PAGE_SIZE,
      });
      const hands: Array<{ id: string; phf: PhfHand }> = fetched ?? [];
      if (hands.length === 0) {
        done = true;
        break;
      }
      const batch = await engine.run(hands);
      for (let i = 0; i < batch.rows.length; i += WRITE_SIZE) {
        const slice: HandAnalysisInsert[] = batch.rows.slice(i, i + WRITE_SIZE);
        const saved = await rpc<{ inserted?: number } | null>("save_hand_analysis", { p_rows: slice });
        total.saved += saved?.inserted ?? 0;
      }
      total.processed += hands.length;
      total.failed += batch.failed.length;
      after = hands[hands.length - 1].id;
      onProgress?.({ ...total });
      if (hands.length < PAGE_SIZE) {
        done = true;
        break;
      }
    }
    if (done) {
      for (let i = 0; i < MAX_PRUNE_CALLS; i += 1) {
        const pruned = await rpc<{ deleted?: number; more?: boolean } | null>("prune_hand_analysis", {
          p_keep_version: ANALYSIS_VERSION,
          p_limit: 20_000,
        });
        total.pruned += pruned?.deleted ?? 0;
        if (!pruned?.more) break;
      }
      onProgress?.({ ...total });
    }
  } finally {
    engine.close();
  }
  return total;
}

/* --------------------------------------------------------------- reports - */

export interface CountByReason {
  reason: string;
  count: number;
}

export interface FlagCount {
  code: string;
  street: string;
  severity: "note" | "inaccurate";
  count: number;
}

export interface StreetSummary {
  street: string;
  decisions: number;
  analysed: number;
  flagged: number;
  facingBet: number;
  defended: number;
  /** Mean MDF over the analysed decisions that faced a bet; null with none. */
  mdf: number | null;
}

export interface AnalysisOverview {
  analysisVersion: string;
  hands: number;
  status: { full: number; partial: number; notAnalysed: number };
  reasons: CountByReason[];
  skipped: CountByReason[];
  decisions: number;
  analysed: number;
  flagged: number;
  flaggedHands: number;
  flags: FlagCount[];
  streets: StreetSummary[];
  grades: Array<{ grade: string; decisions: number }>;
  score: number | null;
  evLossBb: number | null;
  approximations: Array<{ approximation: string; hands: number }>;
}

function streetSummary(row: Row): StreetSummary {
  return {
    street: str(row.street) ?? "",
    decisions: num(row.decisions),
    analysed: num(row.analysed),
    flagged: num(row.flagged),
    facingBet: num(row.facingBet),
    defended: num(row.defended),
    mdf: maybeNum(row.mdf),
  };
}

export async function fetchAnalysisOverview(filters: AnalysisFilters = {}): Promise<AnalysisOverview | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_overview", { p_filters: withVersion(filters) });
  if (!payload) {
    return null;
  }
  const status = (payload.status ?? {}) as Row;
  return {
    analysisVersion: str(payload.analysisVersion) ?? ANALYSIS_VERSION,
    hands: num(payload.hands),
    status: { full: num(status.full), partial: num(status.partial), notAnalysed: num(status.notAnalysed) },
    reasons: rows(payload.reasons).map((row) => ({ reason: str(row.reason) ?? "", count: num(row.hands) })),
    skipped: rows(payload.skipped).map((row) => ({ reason: str(row.reason) ?? "", count: num(row.decisions) })),
    decisions: num(payload.decisions),
    analysed: num(payload.analysed),
    flagged: num(payload.flagged),
    flaggedHands: num(payload.flaggedHands),
    flags: rows(payload.flags).map((row) => ({
      code: str(row.code) ?? "",
      street: str(row.street) ?? "",
      severity: row.severity === "inaccurate" ? "inaccurate" : "note",
      count: num(row.count),
    })),
    streets: rows(payload.streets).map(streetSummary),
    grades: rows(payload.grades).map((row) => ({ grade: str(row.grade) ?? "", decisions: num(row.decisions) })),
    score: maybeNum(payload.score),
    evLossBb: maybeNum(payload.evLossBb),
    approximations: rows(payload.approximations).map((row) => ({
      approximation: str(row.approximation) ?? "",
      hands: num(row.hands),
    })),
  };
}

export type AnalysisBreakdownGroup = "street" | "position" | "pot_type" | "scenario";

export interface AnalysisBreakdownRow extends StreetSummary {
  key: string | null;
  hands: number;
  inaccurate: number;
}

export async function fetchAnalysisBreakdown(
  filters: AnalysisFilters,
  group: AnalysisBreakdownGroup,
): Promise<AnalysisBreakdownRow[]> {
  if (!(await currentUserId())) {
    return [];
  }
  const payload = await rpc<Row | null>("analysis_breakdown", { p_filters: withVersion(filters), p_group: group });
  return rows(payload?.rows).map((row) => ({
    ...streetSummary(row),
    key: str(row.key),
    hands: num(row.hands),
    inaccurate: num(row.inaccurate),
  }));
}

/** Sort keys `analysis_hands` accepts. */
export const ANALYSIS_SORTS = ["recent", "oldest", "flags", "ev_loss", "score", "result"] as const;
export type AnalysisSort = (typeof ANALYSIS_SORTS)[number];

export interface AnalysisHandDecision {
  ord: number;
  actionIndex: number;
  street: string;
  action: string;
  status: string;
  grade: string | null;
  worstFlag: "note" | "inaccurate" | null;
}

export interface AnalysisHandRow {
  handId: string;
  playedAt: string | null;
  site: string;
  stakesLabel: string | null;
  gameFormat: string | null;
  position: string | null;
  heroCards: string[];
  handClass: string | null;
  potType: string | null;
  status: HandAnalysis["status"];
  reason: string | null;
  grade: string | null;
  score: number | null;
  evLossBb: number | null;
  flagCount: number;
  worstFlag: "note" | "inaccurate" | null;
  netBb: number | null;
  decisions: AnalysisHandDecision[];
}

export interface AnalysisHandsPage {
  total: number;
  rows: AnalysisHandRow[];
}

const severity = (value: unknown): "note" | "inaccurate" | null =>
  value === "inaccurate" ? "inaccurate" : value === "note" ? "note" : null;

export async function fetchAnalysisHands(
  filters: AnalysisFilters,
  sort: AnalysisSort,
  limit: number,
  offset: number,
): Promise<AnalysisHandsPage> {
  if (!(await currentUserId())) {
    return { total: 0, rows: [] };
  }
  const payload = await rpc<Row | null>("analysis_hands", {
    p_filters: withVersion(filters),
    p_sort: sort,
    p_limit: limit,
    p_offset: offset,
  });
  return {
    total: num(payload?.total),
    rows: rows(payload?.rows).map((row) => ({
      handId: String(row.handId ?? ""),
      playedAt: str(row.playedAt),
      site: str(row.site) ?? "",
      stakesLabel: str(row.stakesLabel),
      gameFormat: str(row.gameFormat),
      position: str(row.position),
      heroCards: Array.isArray(row.heroCards) ? (row.heroCards as string[]) : [],
      handClass: str(row.handClass),
      potType: str(row.potType),
      status: (str(row.status) ?? "not-analysed") as HandAnalysis["status"],
      reason: str(row.reason),
      grade: str(row.grade),
      score: maybeNum(row.score),
      evLossBb: maybeNum(row.evLossBb),
      flagCount: num(row.flagCount),
      worstFlag: severity(row.worstFlag),
      netBb: maybeNum(row.netBb),
      decisions: rows(row.decisions).map((decision) => ({
        ord: num(decision.ord),
        actionIndex: num(decision.actionIndex),
        street: str(decision.street) ?? "",
        action: str(decision.action) ?? "",
        status: str(decision.status) ?? "",
        grade: str(decision.grade),
        worstFlag: severity(decision.worstFlag),
      })),
    })),
  };
}

/**
 * One hand's stored analysis at the current version, as the engine's own
 * record, or null when there is none (not analysed yet, or not the caller's).
 */
export async function fetchHandAnalysis(handId: string): Promise<HandAnalysis | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_hand", { p_hand_id: handId, p_version: ANALYSIS_VERSION });
  return payload ? handAnalysisFromStored(payload) : null;
}
