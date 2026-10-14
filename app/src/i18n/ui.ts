import type { UiStrings } from "@rail/ui/i18n";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";

import { en } from "./en";
import { hr } from "./hr";
import type { Dict, Locale } from "./types";

/** The language's BCP 47 tag for `Intl`, as the web uses it. */
export const INTL_LOCALE: Record<Locale, string> = { en: "en-GB", hr: "hr-HR" };

/**
 * The strings the shared UI package's components read (`packages/ui/i18n.tsx`):
 * the replayer's are the package's own dictionaries (`packages/ui/strings/`,
 * the words the web shows, R2.7a), the rest come from this app's
 * dictionaries (`ui`). Built once per language; `I18nProvider` mounts them.
 */
function uiStrings(locale: Locale, dict: Dict, replayer: UiStrings["replayer"]): UiStrings {
  return {
    intlLocale: INTL_LOCALE[locale],
    closeNamed: dict.ui.closeNamed,
    replayer,
    statTile: dict.ui.statTile,
    statTable: dict.ui.statTable,
  };
}

export const UI_STRINGS: Record<Locale, UiStrings> = {
  en: uiStrings("en", en, replayerEn),
  hr: uiStrings("hr", hr, replayerHr),
};
