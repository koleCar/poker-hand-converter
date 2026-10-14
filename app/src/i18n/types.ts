import type { en } from "./en";

/** `en`'s shape with every literal widened: what another language fills. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => string
    ? (...args: A) => string
    : { readonly [K in keyof T]: Widen<T[K]> };

export type Dict = Widen<typeof en>;

export type Locale = "en" | "hr";

/** Every language, in Settings' order. */
export const LOCALES: readonly Locale[] = ["en", "hr"];

/**
 * English is the default; Croatian is chosen in Settings, Appearance (R2.8:
 * the settings' `locale`, which the tray follows too).
 */
export const DEFAULT_LOCALE: Locale = "en";

/** The language's BCP 47 tag for `Intl`, as the web uses it. */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", hr: "hr-HR" };
