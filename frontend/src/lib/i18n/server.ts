import "server-only";

import { cookies, headers } from "next/headers";
import { cache } from "react";
import { DICTIONARIES } from "./dictionaries";
import { LOCALE_COOKIE, negotiateLocale, type Dict, type Locale } from "./types";

/**
 * The request's locale, server-side: the reader's choice (`rail.locale`), else
 * their browser's `Accept-Language`, else English. One answer per request.
 *
 * The URL does not change with the language. A `/hr/` prefix would mean every
 * link in the app learning about locales; a cookie means none of them do, and
 * the pages are rendered per request anyway (the root layout reads the session).
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const [store, head] = await Promise.all([cookies(), headers()]);
  return negotiateLocale(store.get(LOCALE_COOKIE)?.value, head.get("accept-language"));
});

/** The strings for this request. Server components, metadata and routes. */
export const getDict = cache(async (): Promise<Dict> => DICTIONARIES[await getLocale()]);
