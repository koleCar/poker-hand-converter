"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { ProgressTab } from "../../../components/analysis/progress/ProgressTab";

/** Client half of `/analysis/progress`: the shell, with the Analysis tab selected. */
export function ProgressScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return (
    <AppFrame tab="analysis">
      {({ refreshToken }) => <ProgressTab initialQuery={query} refreshToken={refreshToken} />}
    </AppFrame>
  );
}
