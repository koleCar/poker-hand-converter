import type { JSX } from "react";

import styles from "./App.module.css";
import { Sidebar } from "./components/Sidebar";
import { SETUP, useRoute, type Route } from "./lib/router";
import { FirstRun } from "./screens/FirstRun";
import { Hands } from "./screens/Hands";
import { Hud } from "./screens/Hud";
import { Players } from "./screens/Players";
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
  const Current = SCREEN_COMPONENTS[route];
  return (
    <div className={styles.shell}>
      {/* The first-run screen belongs to Settings (where it is reached later). */}
      <Sidebar current={route === SETUP ? "settings" : route} />
      <main className={styles.main}>
        <Current />
      </main>
    </div>
  );
}
