"use client";

import { AppFrame } from "../../../../components/shell/AppFrame";
import { AnalysisHandView } from "../../../../components/analysis/AnalysisHandView";

/** Client half of `/analysis/h/<id>`: the shell, with the Analysis tab selected. */
export function AnalysisHandScreen({
  handId,
  query,
}: {
  handId: string;
  query: Record<string, string | string[] | undefined>;
}) {
  return <AppFrame tab="analysis">{() => <AnalysisHandView handId={handId} query={query} />}</AppFrame>;
}
