/**
 * The trainer worker's door to the web's library (`worker.ts`): the pure
 * training jobs (`lib/training/jobs.ts`), the chart library and the flop
 * library's reader - the same modules the web's trainer worker runs, so a
 * spot is dealt and graded identically in the app and on the web. Nothing
 * here imports React: the worker bundles only this.
 */
export { prepareFlopLibrary, runTrainingJob, trainingChartSets, type TrainingRequest, type TrainingResponse } from "@rail/web-lib/training/jobs";
export { ensureChartSets, loadChartLibrary, type ChartLibrary } from "@rail/web-lib/charts";
export { FlopLibraryLoader, type LibraryFetch } from "@rail/web-lib/analysis/flopLibrary";
