import type { en } from "./en";

/**
 * The shape every locale has to fill: `en`'s keys, with its literal string
 * types widened to `string` and its functions keeping their signatures. So a
 * missing key, an extra key or a function that takes the wrong arguments is a
 * type error in `hr.ts`, while the words themselves are free.
 */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer U)[]
      ? readonly Widen<U>[]
      : T extends object
        ? { [K in keyof T]: Widen<T[K]> }
        : T;

export type Dict = Widen<typeof en>;

export const LOCALES = ["en", "hr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** The cookie a reader's choice lives in. Not httpOnly: the switcher writes it. */
export const LOCALE_COOKIE = "rail.locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The locale for a request: the reader's explicit choice if they made one,
 * otherwise the first language in `Accept-Language` we speak, otherwise
 * English. Croatian also answers for Bosnian and Serbian browsers in Latin
 * script, which read it without effort; Slovenian does not.
 */
export function negotiateLocale(cookie: string | undefined | null, acceptLanguage: string | null): Locale {
  if (isLocale(cookie)) {
    return cookie;
  }
  const wanted = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.toLowerCase(), q: q === undefined ? 1 : Number(q) || 0 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    const base = tag.split("-")[0];
    if (base === "en") return "en";
    if (base === "hr" || base === "bs" || tag === "sr-latn" || tag.startsWith("sr-latn")) return "hr";
  }
  return DEFAULT_LOCALE;
}
