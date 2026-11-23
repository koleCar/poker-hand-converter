"use client";

import { AppFrame } from "../../../components/shell/AppFrame";
import { StatsTab } from "../../../components/stats/StatsTab";

/**
 * Client half of `/analysis/stats` (and a stat's drill-down under it): the
 * shell with the Analysis tab lit, and Analytics. `feature={null}`: the
 * player's own numbers are free, and the screen locks only what is Pro
 * (targets, gaps, costs, the drill-down, Pool) itself. `live`: hands arriving
 * from the desktop app re-read the numbers, as on `/stats`.
 */
export function StatsScreen() {
  return (
    <AppFrame tab="analysis" feature={null} live ownsFactsCatchUp>
      {({ refreshToken, arrival }) => <StatsTab mode="analytics" refreshToken={refreshToken} arrival={arrival} />}
    </AppFrame>
  );
}
