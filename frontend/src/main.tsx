import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/shell.css";
import "./styles/share.css";
import "./styles/auth.css";
import App from "./App.tsx";
import { AuthProvider } from "./lib/auth";
import { RouterProvider } from "./routes/router";

/**
 * Resolve the theme and put it on `<html>` before React renders anything.
 *
 * Order of authority:
 *   1. an explicit choice the user made, persisted in localStorage
 *   2. the OS preference, if they have never chosen
 *   3. dark
 *
 * There is no UI for (1) yet — this is only the mechanism, so adding a toggle
 * later is `localStorage.setItem(THEME_KEY, next)` plus the same attribute
 * write. Deliberately not a React context: the value is read once per document
 * and written to an attribute the CSS owns, so putting it in component state
 * would mean re-rendering the tree to change a string on `<html>`.
 *
 * WHERE THIS BELONGS: an inline <script> in the document <head>, before the
 * first stylesheet, so the first paint is already the right theme. It is here
 * instead because `index.html` is being edited elsewhere right now. The
 * practical cost is a one-frame dark flash for a light-preference user, since
 * this module runs after the CSS has applied the dark default. Move it into
 * the head at the Next.js migration — in Next that is a small inline script in
 * the root layout, and the flash goes away.
 */
const THEME_KEY = "rail.theme";

function resolveTheme(): "dark" | "light" {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Private mode, or storage disabled. Fall through to the OS preference.
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

document.documentElement.setAttribute("data-theme", resolveTheme());

// AuthProvider sits above the router rather than inside a route: the session is
// the same on every screen, and re-subscribing to `onAuthStateChange` on each
// navigation would drop and recreate the listener for no reason.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider>
        <App />
      </RouterProvider>
    </AuthProvider>
  </StrictMode>,
);
