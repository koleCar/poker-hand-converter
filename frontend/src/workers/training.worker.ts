/**
 * Trainer worker (phase A7).
 *
 * Dealing a river spot walks two ranges and solves a river (~5–400 ms), and
 * grading an answer runs the analysis on the spot's hand (a river answer
 * solves again, sometimes twice for the sensitivity check). Off the main
 * thread, so the felt and the buttons stay responsive while it works. The
 * jobs themselves are `lib/training/jobs.ts`; this file owns nothing but the
 * calls, the chart library (each set loaded once for the worker's life) and,
 * for the Learn flop drills (L2), the flop library: one chunk fetched per
 * spot from the public Storage bucket, kept for the worker's life, never
 * bundled.
 */

import { flopLibraryBase, FLOP_LIBRARY_ENABLED, FlopLibraryLoader } from "../lib/analysis";
import { ensureChartSets, loadChartLibrary, type ChartLibrary } from "../lib/charts";
import { SUPABASE_URL } from "../lib/supabase/config";
import { prepareFlopLibrary, runTrainingJob, trainingChartSets, type TrainingRequest, type TrainingResponse } from "../lib/training/jobs";

/** The chart library; each set (table and depth, A2c) loads the first time a job needs it. */
let charts: Promise<ChartLibrary> | null = null;

/** The flop library (A5b), while the flag is on and a Supabase URL is configured. */
let flopLibrary: FlopLibraryLoader | null | undefined;

function loader(): FlopLibraryLoader | null {
  if (flopLibrary === undefined) {
    const base = flopLibraryBase(SUPABASE_URL);
    flopLibrary = FLOP_LIBRARY_ENABLED && base ? new FlopLibraryLoader(base, (url) => fetch(url)) : null;
  }
  return flopLibrary;
}

self.onmessage = async (event: MessageEvent<TrainingRequest>) => {
  const request = event.data;
  try {
    charts ??= loadChartLibrary().catch((error: unknown) => {
      charts = null;
      throw error;
    });
    const library = await charts;
    await ensureChartSets(library, trainingChartSets(request));
    const flop = await prepareFlopLibrary(request, library, loader());
    self.postMessage(runTrainingJob(request, library, flop));
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId: request.jobId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies TrainingResponse);
  }
};
