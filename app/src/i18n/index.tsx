import { createContext, useContext, type ReactNode } from "react";
import { UiStringsProvider } from "@rail/ui/i18n";

import { en } from "./en";
import { hr } from "./hr";
import { DEFAULT_LOCALE, type Dict, type Locale } from "./types";
import { UI_STRINGS } from "./ui";

export type { Dict, Locale } from "./types";

const DICTIONARIES: Record<Locale, Dict> = { en, hr };

const I18nContext = createContext<Dict>(DICTIONARIES[DEFAULT_LOCALE]);

/** The app's dictionary and, for the shared UI package, its strings in the same language. */
export function I18nProvider({ locale = DEFAULT_LOCALE, children }: { locale?: Locale; children: ReactNode }) {
  return (
    <I18nContext.Provider value={DICTIONARIES[locale]}>
      <UiStringsProvider strings={UI_STRINGS[locale]}>{children}</UiStringsProvider>
    </I18nContext.Provider>
  );
}

/** The dictionary of the active language. */
export function useT(): Dict {
  return useContext(I18nContext);
}
