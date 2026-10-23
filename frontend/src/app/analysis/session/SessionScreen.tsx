"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { SessionReviewTab } from "../../../components/analysis/session/SessionReviewTab";

/** Client half of `/analysis/session`: the shell, with the Analysis tab selected. */
export function SessionScreen({ query }: { query: Record<string, string | string[] | undefined> }) {
  return (
    <AppFrame tab="analysis" live="notify">
      {({ refreshToken }) => <SessionReviewTab initialQuery={query} refreshToken={refreshToken} />}
    </AppFrame>
  );
}
