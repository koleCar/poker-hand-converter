import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DataSourceProvider } from "@rail/ui/data";

import "./index.css";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { adoptSettings } from "./lib/appearance";
import { storeDataSource } from "./lib/dataSource";
import { inApp, ipc } from "./lib/ipc";
import { go, SETUP } from "./lib/router";
import { HudPopupWindow } from "./popup/HudPopup";

// (R3.8) The HUD popup is a window of its own on this page's popup route
// (`src-tauri/src/popup.rs`): the popup, not the app's screens.
const popup = window.location.hash.startsWith("#/hud-popup");

// The theme, density and language were painted before this script ran
// (`public/appearance.js`, from the copy `lib/appearance.ts` keeps); the
// settings file is the source of truth and corrects them if they differ.
// Outside the app (a plain browser on the Vite server) there is no Rust side.
// Until the first-run screen was finished or skipped (R1.4), the window
// opens on it.
if (inApp) {
  ipc
    .getSettings()
    .then((settings) => {
      adoptSettings(settings);
      if (!popup && !settings.firstRunDone) {
        go(SETUP);
      }
    })
    .catch(() => undefined);
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nProvider>
        {popup ? (
          <HudPopupWindow />
        ) : (
          <DataSourceProvider source={storeDataSource}>
            <App />
          </DataSourceProvider>
        )}
      </I18nProvider>
    </StrictMode>,
  );
}
