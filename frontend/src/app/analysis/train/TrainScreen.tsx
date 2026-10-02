"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { TrainTab } from "../../../components/analysis/train/TrainTab";

/** Client half of `/analysis/train`: the shell, with the Analysis tab selected. */
export function TrainScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return <AppFrame tab="analysis">{() => <TrainTab initialQuery={query} />}</AppFrame>;
}
