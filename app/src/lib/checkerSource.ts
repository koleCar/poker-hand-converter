/**
 * The Analytics stat checker's data in the app (docs/ANALYTICS.md Step 2):
 * `CheckerSource` of `@rail/ui/analytics/model` over the store's commands
 * (`analytics_checker`, `analytics_checker_examples`: the web's RPCs of the
 * same names over the store's checker rows, `rail_store::checker`). The
 * rows are written by the store with each analysed hand and by its
 * background backfill, so the app sends nothing.
 */
import type { CheckerSource } from "@rail/ui/analytics/model";

import { ANALYSIS_VERSION } from "../analysis/library";
import { ipc } from "./ipc";

export const checkerSource: CheckerSource = {
  checker: (filters) => ipc.analyticsChecker(filters.analysisVersion ?? ANALYSIS_VERSION, filters),
  examples: (filters, query) =>
    ipc.analyticsCheckerExamples(filters.analysisVersion ?? ANALYSIS_VERSION, filters, query),
};
