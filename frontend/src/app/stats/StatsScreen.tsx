"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { StatsTab } from "../../components/stats/StatsTab";

/** Client half of `/stats`. See `page.tsx` for why there is no redirect here. */
export function StatsScreen() {
  return (
    <AppFrame tab="stats">
      {({ refreshToken }) => <StatsTab refreshToken={refreshToken} />}
    </AppFrame>
  );
}
