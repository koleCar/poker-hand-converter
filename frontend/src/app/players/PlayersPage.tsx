"use client";

import { AppFrame } from "../../components/shell/AppFrame";
import { PlayersTab } from "../../components/players/PlayersTab";

/**
 * Client half of `/players`. `live`: hands arriving from the desktop app
 * get their statistics (and, with opponent statistics on, their opponents)
 * derived and the list reads again (Rail R1.10). Part of full reports (Pro,
 * R6.2): locked when the plan lacks them and enforcement is on.
 */
export function PlayersPage() {
  return (
    <AppFrame tab="stats" live feature="reports_full">
      {({ refreshToken, arrival }) => <PlayersTab refreshToken={refreshToken} arrival={arrival} />}
    </AppFrame>
  );
}
