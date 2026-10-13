import { createContext, useContext, type ReactNode } from "react";

import { en } from "./en";
import { hr } from "./hr";
import { DEFAULT_LOCALE, type Dict, type Locale } from "./types";

export type { Dict, Locale } from "./types";

const DICTIONARIES: Record<Locale, Dict> = { en, hr };

const I18nContext = createContext<Dict>(DICTIONARIES[DEFAULT_LOCALE]);

export function I18nProvider({ locale = DEFAULT_LOCALE, children }: { locale?: Locale; children: ReactNode }) {
  return <I18nContext.Provider value={DICTIONARIES[locale]}>{children}</I18nContext.Provider>;
}

/** The dictionary of the active language. */
export function useT(): Dict {
  return useContext(I18nContext);
}
