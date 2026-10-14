/**
 * Numbers and dates in the chosen language (R2.8): `Intl` with the
 * language's tag (`INTL_LOCALE`: en-GB, hr-HR, as the web), never the
 * webview's default - an English window on a Croatian system groups
 * thousands with a comma, a Croatian one with a dot.
 *
 * The formatters are "live": made once at module level as before, they pick
 * the current language at each call, so a screen formats in the language it
 * renders in. `lib/appearance.ts` sets the language (on start and when
 * Settings changes it); the screens re-render with the new dictionary.
 * Pure, so the dictionaries and the tests can import it.
 */
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from "./types";

let tag = INTL_LOCALE[DEFAULT_LOCALE];
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

/** Called by `lib/appearance.ts`; the tests call it to pin a language. */
export function setFormatLocale(locale: Locale): void {
  tag = INTL_LOCALE[locale];
}

/** The current language's BCP 47 tag. */
export function formatLocale(): string {
  return tag;
}

function numberIn(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.NumberFormat | undefined;
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    cache.set(key, format);
  }
  return format;
}

function dateIn(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    cache.set(key, format);
  }
  return format;
}

export interface LiveNumberFormat {
  format: (value: number) => string;
}

export interface LiveDateFormat {
  format: (value: Date | number) => string;
}

/** `new Intl.NumberFormat(<current language>, options)`, resolved at each call. */
export function liveNumberFormat(options: Intl.NumberFormatOptions = {}): LiveNumberFormat {
  return { format: (value) => numberIn(tag, options).format(value) };
}

/** `new Intl.DateTimeFormat(<current language>, options)`, resolved at each call. */
export function liveDateFormat(options: Intl.DateTimeFormatOptions = {}): LiveDateFormat {
  return { format: (value) => dateIn(tag, options).format(value) };
}

/** A count in one language, whatever the current one: for the dictionaries. */
export function countIn(locale: Locale): (value: number) => string {
  return (value) => numberIn(INTL_LOCALE[locale], {}).format(value);
}
