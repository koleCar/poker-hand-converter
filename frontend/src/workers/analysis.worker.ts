/**
 * Analysis worker.
 *
 * `analyzeHand` is pure CPU — a decision walk, equities against ranges, and
 * since A4 a river solve for every heads-up hand that reaches one (median
 * ~0.1 s, the slowest about a second). Over a whole library that is a minute
 * or more of solid work, and on the main thread it would freeze the tab the
 * progress bar is drawn in. So the rebuild (`runAnalysis` in
 * `lib/db/analysis.ts`) fetches a page, hands it here, and writes what comes
 * back; this file owns nothing but the calls.
 *
 * Three requests:
 *
 * - `analyse`: a page of stored hands in, rows out, with a `progress` message
 *   every quarter second or so in between, so the bar moves within a page.
 * - `study`: one hand's river or turn decision, re-solved for the study grid
 *   (`riverStudy` / `turnStudy`). The same solve the stored grade came from,
 *   bit for bit.
 * - `hand`: one hand analysed for the hand view when it has no stored row at
 *   the current version — off the main thread, since it may solve a river.
 *
 * Stateless by design apart from the chart set, which is loaded once.
 * Cancelling is the client's job: it terminates the worker, and a page that
 * is analysed but never written is simply analysed again next run —
 * "missing" is computed by the database.
 */

import {
  analyzeHand,
  riverStudy,
  turnStudy,
  type HandAnalysis,
  type RiverFailure,
  type RiverStudy,
  type TurnFailure,
} from "../lib/analysis";
import { loadDefaultCharts, type ChartSet } from "../lib/charts";
import { analyseStoredHands, type AnalysedBatch } from "../lib/db/analysisRows";
import type { PhfHand } from "../lib/phf/types";

export interface AnalyseRequest {
  type: "analyse";
  jobId: number;
  page: Array<{ id: string; phf: PhfHand }>;
}

export interface StudyRequest {
  type: "study";
  jobId: number;
  phf: PhfHand;
  actionIndex: number;
  /** Which street's solve; the river when absent. */
  street?: "river" | "turn";
  /** A river study: narrow through the solved turn (default) or the heuristic (the river trainer's spots). */
  turn?: boolean;
}

export interface HandRequest {
  type: "hand";
  jobId: number;
  phf: PhfHand;
}

export type AnalysisWorkerRequest = AnalyseRequest | StudyRequest | HandRequest;

export type AnalysisWorkerResponse =
  | ({ type: "analysed"; jobId: number } & AnalysedBatch)
  | { type: "progress"; jobId: number; done: number }
  | { type: "studied"; jobId: number; study: RiverStudy | RiverFailure | TurnFailure | null }
  | { type: "hand"; jobId: number; analysis: HandAnalysis }
  | { type: "error"; jobId: number; message: string };

/** How often, at most, a page reports progress. */
const PROGRESS_MS = 250;

/** The preflop charts, loaded on the first request and kept for the worker's life. */
let charts: Promise<ChartSet> | null = null;

self.onmessage = async (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  const { jobId } = request;
  try {
    charts ??= loadDefaultCharts();
    const set = await charts;
    if (request.type === "hand") {
      const analysis = analyzeHand(request.phf, { charts: set });
      self.postMessage({ type: "hand", jobId, analysis } satisfies AnalysisWorkerResponse);
      return;
    }
    if (request.type === "study") {
      const study =
        request.street === "turn"
          ? turnStudy(request.phf, request.actionIndex, { charts: set })
          : riverStudy(request.phf, request.actionIndex, { charts: set, turn: request.turn ?? true });
      self.postMessage({ type: "studied", jobId, study } satisfies AnalysisWorkerResponse);
      return;
    }
    let last = Date.now();
    const batch = analyseStoredHands(request.page, set, (done) => {
      const now = Date.now();
      if (now - last >= PROGRESS_MS) {
        last = now;
        self.postMessage({ type: "progress", jobId, done } satisfies AnalysisWorkerResponse);
      }
    });
    self.postMessage({ type: "analysed", jobId, ...batch } satisfies AnalysisWorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies AnalysisWorkerResponse);
  }
};
