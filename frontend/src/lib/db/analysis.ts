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

import {
  ANALYSIS_VERSION,
  analyzeHand,
  riverStudy,
  turnStudy,
  type HandAnalysis,
  type RiverFailure,
  type RiverStudy,
  type TurnFailure,
} from "../analysis";
import { preflopCharts } from "../chartSet";

export { preflopCharts };
import type { PhfHand } from "../phf/types";
import { currentUserId, rpc } from "./client";
import {
  analyseStoredHands,
  handAnalysisFromStored,
  type AnalysedBatch,
  type HandAnalysisInsert,
} from "./analysisRows";
import type { AnalyseRequest, AnalysisWorkerRequest, AnalysisWorkerResponse } from "../../workers/analysis.worker";

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
  /** The hand's worst grade is exactly this. */
  grade?: string;
  /** The hand's worst grade is at least this bad (`mistake`: a Mistake or a Blunder). */
  minGrade?: string;
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
  /** Seconds left at the pace so far; null until there is a pace to go by (or no target). */
  etaSeconds?: number | null;
}

export interface AnalysisRunOptions {
  /** How many hands the run is expected to analyse, for the time left. */
  target?: number;
  /** Analyse only the most recent this many hands still missing at this version, newest first. */
  recent?: number;
}

/** Hands per read; `hands_needing_analysis` caps at 200. */
const PAGE_SIZE = 100;
/** Hands per worker job: small enough that the pool stays busy to the end. */
const CHUNK = 20;
/** At most this many analysis workers at once. */
const MAX_WORKERS = 4;
/** No estimate of the time left before this many hands and seconds. */
const ETA_MIN_HANDS = 20;
const ETA_MIN_SECONDS = 5;

/** Workers side by side: one per core but one (the tab's), at most `MAX_WORKERS`. */
function poolSize(): number {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}
/** Hands per write: `save_hand_analysis` takes 200, and a hand's facts are ~1–4 KB. */
const WRITE_SIZE = 50;
const MAX_PRUNE_CALLS = 10;

let jobSequence = 0;


/** Thrown out of a page when the run is stopped mid-page: the worker is gone. */
class Stopped extends Error {}

function newWorker(): Worker | null {
  try {
    return new Worker(new URL("../../workers/analysis.worker.ts", import.meta.url), {
      type: "module",
      name: "rail-analysis",
    });
  } catch {
    return null;
  }
}

/**
 * Analyses one page off the main thread, or on it when a worker cannot be
 * created (a strict CSP, an embedded webview) — slower and janky, but a screen
 * that silently never finishes would be worse.
 *
 * `onHand` hears how many hands of the page are done as the worker goes (a
 * page with river solves takes seconds). Stopping terminates the worker at
 * once, mid-page, rather than waiting for the page to finish: what was not
 * written is simply missing next time.
 */
function analyser(signal?: AbortSignal): {
  run: (page: AnalyseRequest["page"], onHand?: (done: number) => void) => Promise<AnalysedBatch>;
  close: () => void;
  /** In a worker; false when it fell back to the main thread (then the pool is just this one). */
  threaded: boolean;
} {
  const worker = newWorker();
  if (!worker) {
    return {
      threaded: false,
      run: async (page, onHand) => {
        // Yield first so the progress line repaints between pages.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return analyseStoredHands(page, await preflopCharts(), onHand);
      },
      close: () => {},
    };
  }
  const live = worker;
  let stop: (() => void) | null = null;
  const onAbort = () => {
    live.terminate();
    stop?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    threaded: true,
    run: (page, onHand) =>
      new Promise<AnalysedBatch>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Stopped("stopped"));
          return;
        }
        jobSequence += 1;
        const jobId = jobSequence;
        stop = () => reject(new Stopped("stopped"));
        live.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
          const message = event.data;
          if (message.jobId !== jobId) return;
          if (message.type === "progress") onHand?.(message.done);
          else if (message.type === "analysed") resolve({ rows: message.rows, failed: message.failed });
          else if (message.type === "error") reject(new Error(message.message));
        };
        live.onerror = (event) => reject(new Error(event.message || "analysis worker failed"));
        live.postMessage({ type: "analyse", jobId, page } satisfies AnalyseRequest);
      }),
    close: () => {
      signal?.removeEventListener("abort", onAbort);
      live.terminate();
    },
  };
}

/* ------------------------------------------------------------- hand view - */

/** The hand view's own worker: a fresh analysis and river studies, off the main thread. */
let viewWorker: Worker | null | undefined;

function askViewWorker<T>(
  request: AnalysisWorkerRequest,
  pick: (message: AnalysisWorkerResponse) => T | undefined,
): Promise<T> {
  const live = viewWorker as Worker;
  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const message = event.data;
      if (message.jobId !== request.jobId) return;
      live.removeEventListener("message", onMessage);
      if (message.type === "error") {
        reject(new Error(message.message));
        return;
      }
      const value = pick(message);
      if (value === undefined) reject(new Error(`unexpected ${message.type} from the analysis worker`));
      else resolve(value);
    };
    live.addEventListener("message", onMessage);
    live.postMessage(request);
  });
}

/**
 * A hand analysed here and now, the way the rebuild would store it: the hand
 * view's answer for a hand with no row at the current version. In a worker
 * when one can be made: a river solve can take a second.
 */
export async function analyseHandNow(phf: PhfHand): Promise<HandAnalysis> {
  if (viewWorker === undefined) viewWorker = newWorker();
  if (!viewWorker) return analyzeHand(phf, { charts: await preflopCharts() });
  jobSequence += 1;
  return askViewWorker({ type: "hand", jobId: jobSequence, phf }, (message) =>
    message.type === "hand" ? message.analysis : undefined,
  );
}

/**
 * The river study for one hero river decision of a hand on screen: the same
 * walk and solve the stored grade came from, re-run (§3.4 stores no strategy).
 * Null when the decision is not a river decision the analysis covers.
 */
export async function studyRiver(
  phf: PhfHand,
  actionIndex: number,
  options: { turn?: boolean } = {},
): Promise<RiverStudy | RiverFailure | null> {
  return (await studyStreet(phf, actionIndex, "river", options.turn ?? true)) as RiverStudy | RiverFailure | null;
}

/**
 * The turn study (A5a) for one hero turn decision: the same walk and turn
 * solve the stored grade came from, re-run in the worker (a second or two).
 */
export async function studyTurn(phf: PhfHand, actionIndex: number): Promise<RiverStudy | TurnFailure | null> {
  return (await studyStreet(phf, actionIndex, "turn", true)) as RiverStudy | TurnFailure | null;
}

async function studyStreet(
  phf: PhfHand,
  actionIndex: number,
  street: "river" | "turn",
  turn: boolean,
): Promise<RiverStudy | RiverFailure | TurnFailure | null> {
  if (viewWorker === undefined) viewWorker = newWorker();
  if (!viewWorker) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const charts = await preflopCharts();
    return street === "turn"
      ? turnStudy(structuredClone(phf), actionIndex, { charts })
      : riverStudy(structuredClone(phf), actionIndex, { charts, turn });
  }
  jobSequence += 1;
  return askViewWorker({ type: "study", jobId: jobSequence, phf, actionIndex, street, turn }, (message) =>
    message.type === "studied" ? message.study : undefined,
  );
}

/**
 * Analyses every hand of the caller's that has no row at the current
 * `ANALYSIS_VERSION`, then prunes rows from older versions; or, with
 * `options.recent`, only the most recent that many of them, newest first
 * (A5a: a turn solve costs a second or two, so a large library takes
 * minutes, and the reader wants their latest sessions first). A recent-only
 * run never prunes: the older hands still have their old rows until a full
 * run reaches them.
 *
 * **A pool of workers** (one per spare core, at most `MAX_WORKERS`) analyses
 * chunks of `CHUNK` hands side by side; pages are read one at a time behind
 * them and every chunk is written as soon as it is done. Progress counts the
 * hands done, inside chunks too, and estimates the time left from the pace so
 * far once there is one (`etaSeconds`).
 *
 * Safe to run twice at once and safe to interrupt: every write is
 * `on conflict do nothing` and what is missing is recomputed by the
 * database. `signal` stops it at once (the workers are terminated mid-chunk);
 * a chunk analysed but not written is simply missing next time.
 */
export async function runAnalysis(
  onProgress?: (progress: AnalysisProgress) => void,
  signal?: AbortSignal,
  options: AnalysisRunOptions = {},
): Promise<AnalysisProgress> {
  const total: AnalysisProgress = { processed: 0, saved: 0, failed: 0, pruned: 0, etaSeconds: null };
  if (!(await currentUserId())) {
    return total;
  }
  const recent = options.recent !== undefined && options.recent > 0 ? Math.floor(options.recent) : null;
  const target = recent ?? options.target ?? null;

  // One controller for the pool: the caller's stop, or the first failure.
  const inner = new AbortController();
  const onStop = () => inner.abort();
  signal?.addEventListener("abort", onStop, { once: true });
  if (signal?.aborted) inner.abort();

  const first = analyser(inner.signal);
  const engines = [first];
  if (first.threaded) {
    for (let k = 1; k < poolSize(); k += 1) engines.push(analyser(inner.signal));
  }

  // The read side: pages one at a time, cut into chunks for the pool.
  const queue: Array<AnalyseRequest["page"]> = [];
  let after: string | null = null;
  let beforePlayed: string | null = null;
  let beforeId: string | null = null;
  let fetched = 0;
  let exhausted = false;
  let reading: Promise<void> | null = null;
  const read = async (): Promise<void> => {
    if (exhausted) return;
    const want = recent === null ? PAGE_SIZE : Math.min(PAGE_SIZE, recent - fetched);
    if (want <= 0) {
      exhausted = true;
      return;
    }
    let hands: Array<{ id: string; phf: PhfHand }>;
    if (recent === null) {
      const page: Array<{ id: string; phf: PhfHand }> | null = await rpc("hands_needing_analysis", {
        p_version: ANALYSIS_VERSION,
        p_after: after ?? undefined,
        p_limit: want,
      });
      hands = page ?? [];
      if (hands.length > 0) after = hands[hands.length - 1].id;
    } else {
      const page: Array<{ id: string; played_at: string | null; phf: PhfHand }> | null = await rpc(
        "hands_needing_analysis_recent",
        {
          p_version: ANALYSIS_VERSION,
          p_before_played: beforePlayed ?? undefined,
          p_before_id: beforeId ?? undefined,
          p_limit: want,
        },
      );
      const rowsRead = page ?? [];
      if (rowsRead.length > 0) {
        beforePlayed = rowsRead[rowsRead.length - 1].played_at;
        beforeId = rowsRead[rowsRead.length - 1].id;
      }
      hands = rowsRead.map(({ id, phf }) => ({ id, phf }));
    }
    fetched += hands.length;
    if (hands.length < want || (recent !== null && fetched >= recent)) exhausted = true;
    for (let i = 0; i < hands.length; i += CHUNK) queue.push(hands.slice(i, i + CHUNK));
  };
  const next = async (): Promise<AnalyseRequest["page"] | null> => {
    // Bounded so a server that never runs dry cannot spin a tab forever.
    for (let guard = 0; guard < 100_000; guard += 1) {
      if (inner.signal.aborted) return null;
      const chunk = queue.shift();
      if (chunk) return chunk;
      if (exhausted) return null;
      reading ??= read().finally(() => {
        reading = null;
      });
      await reading;
    }
    return null;
  };

  const started = Date.now();
  const inChunk = new Map<number, number>();
  const report = () => {
    let partial = 0;
    for (const done of inChunk.values()) partial += done;
    const processed = total.processed + partial;
    const elapsed = (Date.now() - started) / 1000;
    let etaSeconds: number | null = null;
    if (target !== null && processed >= ETA_MIN_HANDS && elapsed >= ETA_MIN_SECONDS) {
      etaSeconds = Math.max(0, Math.round(((target - processed) * elapsed) / processed));
    }
    total.etaSeconds = etaSeconds;
    onProgress?.({ ...total, processed });
  };

  let failure: unknown = null;
  const lane = async (k: number) => {
    for (;;) {
      const chunk = await next();
      if (!chunk) return;
      inChunk.set(k, 0);
      let batch: AnalysedBatch;
      try {
        batch = await engines[k].run(chunk, (done) => {
          inChunk.set(k, done);
          report();
        });
      } catch (error) {
        inChunk.delete(k);
        if (error instanceof Stopped) return;
        throw error;
      }
      for (let i = 0; i < batch.rows.length; i += WRITE_SIZE) {
        const slice: HandAnalysisInsert[] = batch.rows.slice(i, i + WRITE_SIZE);
        const saved = await rpc<{ inserted?: number } | null>("save_hand_analysis", { p_rows: slice });
        total.saved += saved?.inserted ?? 0;
      }
      inChunk.delete(k);
      total.processed += chunk.length;
      total.failed += batch.failed.length;
      report();
    }
  };

  try {
    await Promise.all(
      engines.map((_, k) =>
        lane(k).catch((error: unknown) => {
          failure ??= error;
          inner.abort();
        }),
      ),
    );
    if (failure) throw failure;
    const done = exhausted && queue.length === 0 && !inner.signal.aborted;
    if (done && recent === null) {
      for (let i = 0; i < MAX_PRUNE_CALLS; i += 1) {
        const pruned = await rpc<{ deleted?: number; more?: boolean } | null>("prune_hand_analysis", {
          p_keep_version: ANALYSIS_VERSION,
          p_limit: 20_000,
        });
        total.pruned += pruned?.deleted ?? 0;
        if (!pruned?.more) break;
      }
    }
    total.etaSeconds = null;
    onProgress?.({ ...total });
  } finally {
    signal?.removeEventListener("abort", onStop);
    for (const engine of engines) engine.close();
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
  gradesByStreet: Array<{ street: string; grade: string; decisions: number }>;
  /** Graded decisions ("moves"). */
  graded: number;
  /** Hands with at least one graded decision: the denominator of EV loss per 100 hands. */
  gradedHands: number;
  /** Hands whose worst grade is a Mistake or a Blunder. */
  badHands: number;
  score: number | null;
  evLossBb: number | null;
  /** Σ EV loss in pots, over graded decisions. */
  evLossPot: number | null;
  approximations: Array<{ approximation: string; hands: number }>;
}

/** Per grade, a count. */
export type GradeCounts = Record<"perfect" | "good" | "inaccurate" | "mistake" | "blunder", number>;

function gradeCounts(value: unknown): GradeCounts {
  const row = (value ?? {}) as Row;
  return {
    perfect: num(row.perfect),
    good: num(row.good),
    inaccurate: num(row.inaccurate),
    mistake: num(row.mistake),
    blunder: num(row.blunder),
  };
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
    gradesByStreet: rows(payload.gradesByStreet).map((row) => ({
      street: str(row.street) ?? "",
      grade: str(row.grade) ?? "",
      decisions: num(row.decisions),
    })),
    graded: num(payload.graded),
    gradedHands: num(payload.gradedHands),
    badHands: num(payload.badHands),
    score: maybeNum(payload.score),
    evLossBb: maybeNum(payload.evLossBb),
    evLossPot: maybeNum(payload.evLossPot),
    approximations: rows(payload.approximations).map((row) => ({
      approximation: str(row.approximation) ?? "",
      hands: num(row.hands),
    })),
  };
}

export type AnalysisBreakdownGroup = "street" | "position" | "pot_type" | "scenario" | "preflop_scenario";

export interface AnalysisBreakdownRow extends StreetSummary {
  key: string | null;
  hands: number;
  inaccurate: number;
  /** Graded decisions in the group, and the hands they are in. */
  graded: number;
  gradedHands: number;
  grades: GradeCounts;
  evLossBb: number | null;
  score: number | null;
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
    graded: num(row.graded),
    gradedHands: num(row.gradedHands),
    grades: gradeCounts(row.grades),
    evLossBb: maybeNum(row.evLossBb),
    score: maybeNum(row.score),
  }));
}

/** Sort keys `analysis_hands` accepts. */
export const ANALYSIS_SORTS = ["recent", "oldest", "flags", "ev_loss", "ev_loss_pot", "score", "result"] as const;
export type AnalysisSort = (typeof ANALYSIS_SORTS)[number];

export interface AnalysisHandDecision {
  ord: number;
  actionIndex: number;
  street: string;
  action: string;
  status: string;
  grade: string | null;
  evLossBb: number | null;
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
  evLossPot: number | null;
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
      evLossPot: maybeNum(row.evLossPot),
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
        evLossBb: maybeNum(decision.evLossBb),
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
