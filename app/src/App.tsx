import type { JSX } from "react";

import styles from "./App.module.css";
import { Sidebar } from "./components/Sidebar";
import { useScreen, type Screen } from "./lib/router";
import { Hands } from "./screens/Hands";
import { Hud } from "./screens/Hud";
import { Players } from "./screens/Players";
import { Reports } from "./screens/Reports";
import { Settings } from "./screens/settings/Settings";
import { Today } from "./screens/Today";

const SCREEN_COMPONENTS: Record<Screen, () => JSX.Element> = {
  today: Today,
  hands: Hands,
  reports: Reports,
  players: Players,
  hud: Hud,
  settings: Settings,
};

export function App() {
  const screen = useScreen();
  const Current = SCREEN_COMPONENTS[screen];
  return (
    <div className={styles.shell}>
      <Sidebar current={screen} />
      <main className={styles.main}>
        <Current />
      </main>
    </div>
  );
}
