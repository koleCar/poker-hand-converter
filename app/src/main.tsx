import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { inApp, ipc } from "./lib/ipc";
import { applyTheme } from "./lib/theme";

// The saved theme before the first paint of anything but the dark default.
// Outside the app (a plain browser on the Vite server) there is no Rust side.
applyTheme("system");
if (inApp) {
  ipc
    .getSettings()
    .then((settings) => applyTheme(settings.theme))
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
