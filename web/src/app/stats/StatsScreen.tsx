"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { StatsTab } from "../../components/stats/StatsTab";

/**
 * Client half of `/stats`. See `page.tsx` for why there is no redirect here.
 * `live`: hands arriving from the desktop app re-read the numbers and get
 * their statistics derived without a click (Rail R1.10).
 */
export function StatsScreen() {
  return (
    <AppFrame tab="stats" live>
      {({ refreshToken, arrival }) => <StatsTab refreshToken={refreshToken} arrival={arrival} />}
    </AppFrame>
  );
}
