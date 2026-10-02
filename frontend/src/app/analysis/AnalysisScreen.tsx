"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { AnalysisTab } from "../../components/analysis/AnalysisTab";

/** Client half of `/analysis`. See `page.tsx` for why there is no redirect here. */
export function AnalysisScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return (
    <AppFrame tab="analysis">
      {({ refreshToken }) => <AnalysisTab initialQuery={query} refreshToken={refreshToken} />}
    </AppFrame>
  );
}
