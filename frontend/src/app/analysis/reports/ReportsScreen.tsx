"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { ReportsTab } from "../../../components/analysis/reports/ReportsTab";

/** Client half of `/analysis/reports`: the shell, with the Analysis tab selected. */
export function ReportsScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return (
    <AppFrame tab="analysis">
      {({ refreshToken }) => <ReportsTab initialQuery={query} refreshToken={refreshToken} />}
    </AppFrame>
  );
}
