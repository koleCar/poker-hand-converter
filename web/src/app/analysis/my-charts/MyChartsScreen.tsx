"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { MyChartsTab } from "../../../components/analysis/myCharts/MyChartsTab";

/** Client half of `/analysis/my-charts`: the shell, with the Analysis tab selected. */
export function MyChartsScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return <AppFrame tab="analysis">{() => <MyChartsTab initialQuery={query} />}</AppFrame>;
}
