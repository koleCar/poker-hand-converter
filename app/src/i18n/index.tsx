import { createContext, useContext, type ReactNode } from "react";
import { UiStringsProvider } from "@rail/ui/i18n";

import { useAppearance } from "../lib/appearance";
import { en } from "./en";
import { hr } from "./hr";
import { DEFAULT_LOCALE, type Dict, type Locale } from "./types";
import { UI_STRINGS } from "./ui";

export type { Dict, Locale } from "./types";

const DICTIONARIES: Record<Locale, Dict> = { en, hr };

const I18nContext = createContext<Dict>(DICTIONARIES[DEFAULT_LOCALE]);
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/**
 * The app's dictionary and, for the shared UI package, its strings in the
 * same language: the one chosen in Settings (R2.8, `lib/appearance.ts`),
 * unless a `locale` is given.
 */
export function I18nProvider({ locale, children }: { locale?: Locale; children: ReactNode }) {
  const chosen = useAppearance().locale;
  const active = locale ?? chosen;
  return (
    <LocaleContext.Provider value={active}>
      <I18nContext.Provider value={DICTIONARIES[active]}>
        <UiStringsProvider strings={UI_STRINGS[active]}>{children}</UiStringsProvider>
      </I18nContext.Provider>
    </LocaleContext.Provider>
  );
}

/** The dictionary of the active language. */
export function useT(): Dict {
  return useContext(I18nContext);
}

/**
 * The active language: picks a statistic definition's own words
 * (`label`, `name`, `description` are `{ en, hr }`, R2.4).
 */
export function useLocale(): Locale {
  return useContext(LocaleContext);
}
