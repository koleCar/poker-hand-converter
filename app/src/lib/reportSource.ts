/**
 * The shared Reports screen's `ReportSource` (`@rail/ui/reports/model`,
 * R4.5c) over the Tauri commands into the local store (R2.7b): `report`
 * (the hero's statistics, the graph, the rollups' breakdowns),
 * `report_breakdowns` (the breakdowns by situation), the Hands screen's chip
 * counts, the watcher's change event and the store's saved filters.
 */
import type { ReportSource } from "@rail/ui/reports/model";

import { storeHandsSource } from "./handsSource";
import { ipc, onStatsDataChanged } from "./ipc";

/** The graph's resolution: about a point per pixel on a wide window (the store caps it). */
export const GRAPH_POINTS = 1200;

export const storeReportSource: ReportSource = {
  report: (filter, points) => ipc.report(filter, points),
  breakdowns: (filter) => ipc.reportBreakdowns(filter),
  facets: (filter) => ipc.handsFacets(filter),
  onChanged: (listener) => onStatsDataChanged(listener),
  graphPoints: GRAPH_POINTS,
  savedFilters: storeHandsSource.savedFilters,
};
