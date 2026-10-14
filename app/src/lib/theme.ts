/**
 * Applies the theme the way the web does: `data-theme="dark" | "light"` on
 * `<html>`, which `@rail/ui/tokens/theme-light.css` keys on. "system" follows
 * `prefers-color-scheme` and keeps following it while chosen.
 */
import type { Theme } from "./ipc";

const query = window.matchMedia("(prefers-color-scheme: light)");
let following: Theme = "system";

function paint(): void {
  const resolved = following === "system" ? (query.matches ? "light" : "dark") : following;
  document.documentElement.setAttribute("data-theme", resolved);
}

query.addEventListener("change", () => {
  if (following === "system") paint();
});

export function applyTheme(theme: Theme): void {
  following = theme;
  paint();
}
