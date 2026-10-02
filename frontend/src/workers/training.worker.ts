/**
 * Trainer worker (phase A7).
 *
 * Dealing a river spot walks two ranges and solves a river (~5–400 ms), and
 * grading an answer runs the analysis on the spot's hand (a river answer
 * solves again, sometimes twice for the sensitivity check). Off the main
 * thread, so the felt and the buttons stay responsive while it works. The
 * jobs themselves are `lib/training/jobs.ts`; this file owns nothing but the
 * calls and the chart library, each set loaded once for the worker's life.
 */

import { ensureChartSets, loadChartLibrary, type ChartLibrary } from "../lib/charts";
import { runTrainingJob, trainingChartSets, type TrainingRequest, type TrainingResponse } from "../lib/training/jobs";

/** The chart library; each set (table and depth, A2c) loads the first time a job needs it. */
let charts: Promise<ChartLibrary> | null = null;

self.onmessage = async (event: MessageEvent<TrainingRequest>) => {
  const request = event.data;
  try {
    charts ??= loadChartLibrary().catch((error: unknown) => {
      charts = null;
      throw error;
    });
    const library = await charts;
    await ensureChartSets(library, trainingChartSets(request));
    self.postMessage(runTrainingJob(request, library));
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId: request.jobId,
      message: error instanceof Error ? error.message : String(error),
    } satisfies TrainingResponse);
  }
};
