import { DEFAULT_LOCALE, type Locale } from "./types";

/**
 * The browser's current locale, for code that runs outside React — the
 * `rpc()` wrapper translating a server refusal on its way to the screen. Set
 * by `I18nProvider`; one value per tab, which is exactly what a browser has.
 * Never read on the server, where requests share a module.
 */
let active: Locale = DEFAULT_LOCALE;

export function setActiveLocale(locale: Locale): void {
  active = locale;
}

export function activeLocale(): Locale {
  return active;
}
