import { redirect } from "next/navigation";
import { paths } from "../../../lib/routes";

/** Your own preflop charts were removed (2026-11-16); old links land on Rail's charts. */
export default function AnalysisMyChartsPage() {
  redirect(paths.analysisCharts());
}
