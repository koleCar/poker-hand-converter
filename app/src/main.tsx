import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { inApp, ipc } from "./lib/ipc";
import { go, SETUP } from "./lib/router";
import { applyTheme } from "./lib/theme";

// The saved theme before the first paint of anything but the dark default.
// Outside the app (a plain browser on the Vite server) there is no Rust side.
// Until the first-run screen was finished or skipped (R1.4), the window
// opens on it.
applyTheme("system");
if (inApp) {
  ipc
    .getSettings()
    .then((settings) => {
      applyTheme(settings.theme);
      if (!settings.firstRunDone) {
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
        <App />
      </I18nProvider>
    </StrictMode>,
  );
}
