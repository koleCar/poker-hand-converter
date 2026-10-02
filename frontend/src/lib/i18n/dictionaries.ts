import { en } from "./en";
import { hr } from "./hr";
import type { Dict, Locale } from "./types";

/** Both are small and both ship: switching language is a cookie and a refresh. */
export const DICTIONARIES: Record<Locale, Dict> = { en, hr };

/** BCP 47 tags for `Intl` and `<html lang>`. */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", hr: "hr-HR" };
