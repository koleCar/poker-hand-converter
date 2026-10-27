"use client";

import { UiStringsProvider } from "@rail/ui/i18n";
import { createContext, useContext, type ReactNode } from "react";
import { setActiveLocale } from "./active";
import { DICTIONARIES } from "./dictionaries";
import { DEFAULT_LOCALE, LOCALE_COOKIE, type Dict, type Locale } from "./types";
import { UI_STRINGS } from "./ui";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/**
 * Mounted once in the root layout with the locale the server resolved, so the
 * first client render uses the same strings the server did. It also hands the
 * shared UI package (`@rail/ui`: the replayer, cards, tiles, overlays) its
 * slice of the same dictionary - see `ui.ts`.
 */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  // For `rpc()`, which runs outside React. Idempotent, browser only: on the
  // server, requests share this module and must not share a locale.
  if (typeof window !== "undefined") {
    setActiveLocale(locale);
  }
  return (
    <LocaleContext.Provider value={locale}>
      <UiStringsProvider strings={UI_STRINGS[locale]}>{children}</UiStringsProvider>
    </LocaleContext.Provider>
  );
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** The strings, in a client component. */
export function useDict(): Dict {
  return DICTIONARIES[useContext(LocaleContext)];
}

/**
 * Remembers a reader's language for a year. The caller refreshes the route so
 * the server renders the new strings; nothing else has to know.
 */
export function rememberLocale(locale: Locale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; samesite=lax`;
}
