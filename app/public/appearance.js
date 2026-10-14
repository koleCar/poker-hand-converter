/*
 * Runs before the first paint (a classic script in index.html's <head>, which
 * the window's CSP allows as 'self'; R2.8). It reads the copy of the theme,
 * density and language that src/lib/appearance.ts keeps in localStorage and
 * sets the attributes the stylesheets and the dictionaries key on, so a light
 * theme or a Croatian window never shows a dark or English frame first. The
 * same rule as appearance.ts's paint(); the settings file stays the source
 * of truth and corrects the copy once it is read over IPC.
 */
(function () {
  var value = {};
  try {
    value = JSON.parse(window.localStorage.getItem("rail.appearance") || "{}") || {};
  } catch (e) {
    value = {};
  }
  var root = document.documentElement;
  var theme = value.theme === "dark" || value.theme === "light" ? value.theme : "system";
  if (theme === "system") {
    theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-density", value.density === "compact" ? "compact" : "comfortable");
  root.setAttribute("lang", value.locale === "hr" ? "hr" : "en");
})();
