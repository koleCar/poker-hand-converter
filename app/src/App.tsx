import { lazy, Suspense, useEffect, type JSX } from "react";

import styles from "./App.module.css";
import { Palette } from "./components/Palette";
import { useLocale } from "./i18n";
import { Sidebar } from "./components/Sidebar";
import { StateMessage } from "./components/StateMessage";
import { useT } from "./i18n";
import { screenHiddenDuringPlay } from "./lib/duringPlay";
import { onOpenPlayer } from "./lib/ipc";
import { go, SETUP, useRoute, type Route } from "./lib/router";
import { FirstRun } from "./screens/FirstRun";
import { Hands } from "./screens/Hands";
import { Hud } from "./screens/Hud";
import { Players } from "./screens/Players";
import { playerParam } from "./screens/players/param";
import { Reports } from "./screens/Reports";
import { Settings } from "./screens/settings/Settings";
import { Today } from "./screens/Today";
import { useTablesOpen } from "./lib/useTablesOpen";

// (R5.4) The analysis screens are loaded when first opened: their code (the
// shared review and charts screens) stays out of the window's first load.
const Analysis = lazy(() => import("./screens/Analysis").then((m) => ({ default: m.Analysis })));

function AnalysisScreen() {
  const t = useT();
  return (
    <Suspense fallback={<StateMessage kind="loading">{t.analysis.loading}</StateMessage>}>
      <Analysis />
    </Suspense>
  );
}

const SCREEN_COMPONENTS: Record<Route, () => JSX.Element> = {
  today: Today,
  hands: Hands,
  reports: Reports,
  players: Players,
  analysis: AnalysisScreen,
  hud: Hud,
  settings: Settings,
  [SETUP]: FirstRun,
};

export function App() {
  const route = useRoute();
  const locale = useLocale();
  const t = useT();
  // A10: while a poker table is open, a screen that helps with play is not shown.
  const tablesOpen = useTablesOpen();
  // (R3.8) "Open in Rail" from the HUD popup: the player's profile.
  useEffect(() => onOpenPlayer((player) => go("players", playerParam(player.site, player.name))), []);
  const Current = SCREEN_COMPONENTS[route];
  return (
    <div className={styles.shell}>
      {/* The first-run screen belongs to Settings (where it is reached later). */}
      {/* A10 (R3.10): the sidebar and the palette leave out a screen that helps with play while a table is open. */}
      <Sidebar current={route === SETUP ? "settings" : route} tablesOpen={tablesOpen} />
      <main className={styles.main}>
        {/* A new language mounts the screen again: every number and date
            on it is formatted in that language (`i18n/format.ts`). */}
        {screenHiddenDuringPlay(route, tablesOpen) ? (
          <StateMessage kind="empty">{t.duringPlay.hidden}</StateMessage>
        ) : (
          <Current key={locale} />
        )}
      </main>
      <Palette tablesOpen={tablesOpen} />
    </div>
  );
}
