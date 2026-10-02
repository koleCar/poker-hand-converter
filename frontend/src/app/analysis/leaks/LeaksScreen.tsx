"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { LeaksTab } from "../../../components/analysis/leaks/LeaksTab";

/** Client half of `/analysis/leaks`: the shell, with the Analysis tab selected. */
export function LeaksScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return (
    <AppFrame tab="analysis">
      {({ refreshToken }) => <LeaksTab initialQuery={query} refreshToken={refreshToken} />}
    </AppFrame>
  );
}
