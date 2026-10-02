/**
 * Analysis worker.
 *
 * `analyzeHand` is pure CPU — a decision walk plus, for the spots that price a
 * call, an equity against a range (exhaustive on the turn and river, a seeded
 * sample on the flop). Over a whole library that is seconds of solid work, and
 * on the main thread it would freeze the tab the progress bar is drawn in. So
 * the rebuild (`runAnalysis` in `lib/db/analysis.ts`) fetches a page, hands it
 * here, and writes what comes back; this file owns nothing but the call.
 *
 * Stateless by design: a page in, rows out. Cancelling is the client's job (it
 * stops asking), and a page that is analysed but never written is simply
 * analysed again next run — "missing" is computed by the database.
 */

import { analyseStoredHands, type AnalysedBatch } from "../lib/db/analysisRows";
import type { PhfHand } from "../lib/phf/types";

export interface AnalyseRequest {
  type: "analyse";
  jobId: number;
  page: Array<{ id: string; phf: PhfHand }>;
}

export type AnalysisWorkerResponse =
  | ({ type: "analysed"; jobId: number } & AnalysedBatch)
  | { type: "error"; jobId: number; message: string };

self.onmessage = (event: MessageEvent<AnalyseRequest>) => {
  const { jobId, page } = event.data;
  try {
    const batch = analyseStoredHands(page);
    self.postMessage({ type: "analysed", jobId, ...batch } satisfies AnalysisWorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies AnalysisWorkerResponse);
  }
};
