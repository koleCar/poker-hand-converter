import { useEffect, type JSX } from "react";

import styles from "./App.module.css";
import { Palette } from "./components/Palette";
import { useLocale } from "./i18n";
import { Sidebar } from "./components/Sidebar";
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

const SCREEN_COMPONENTS: Record<Route, () => JSX.Element> = {
  today: Today,
  hands: Hands,
  reports: Reports,
  players: Players,
  hud: Hud,
  settings: Settings,
  [SETUP]: FirstRun,
};

export function App() {
  const route = useRoute();
  const locale = useLocale();
  // (R3.8) "Open in Rail" from the HUD popup: the player's profile.
  useEffect(() => onOpenPlayer((player) => go("players", playerParam(player.site, player.name))), []);
  const Current = SCREEN_COMPONENTS[route];
  return (
    <div className={styles.shell}>
      {/* The first-run screen belongs to Settings (where it is reached later). */}
      <Sidebar current={route === SETUP ? "settings" : route} />
      <main className={styles.main}>
        {/* A new language mounts the screen again: every number and date
            on it is formatted in that language (`i18n/format.ts`). */}
        <Current key={locale} />
      </main>
      <Palette />
    </div>
  );
}
