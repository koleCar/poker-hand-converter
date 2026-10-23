import type { UiStrings } from "@rail/ui/i18n";
import { handsUiEn } from "@rail/ui/strings/hands.en";
import { handsUiHr } from "@rail/ui/strings/hands.hr";
import { reportsUiEn } from "@rail/ui/strings/reports.en";
import { reportsUiHr } from "@rail/ui/strings/reports.hr";
import { DICTIONARIES, INTL_LOCALE } from "./dictionaries";
import type { Locale } from "./types";

/**
 * The strings the shared UI package's components read (`packages/ui/i18n.tsx`,
 * R2.6), cut from this site's dictionaries: the replayer's words, the
 * statistic tile's and table's, the win-rate graph's (R2.7b), and the
 * overlays' close label; the Hands screen's words (R4.5b) are the package's
 * own dictionaries (`strings/hands.{en,hr}.ts`), as the app's are. Same objects as
 * `DICTIONARIES`, built once per language, so a component that memoises on
 * them sees the same identity it always did. `I18nProvider` mounts them.
 *
 * Typed against the package's interfaces: a key the package needs and a
 * dictionary lacks is an error here.
 */
function uiStrings(locale: Locale): UiStrings {
  const dict = DICTIONARIES[locale];
  return {
    intlLocale: INTL_LOCALE[locale],
    closeNamed: dict.chrome.closeNamed,
    replayer: dict.replayer,
    statTile: dict.stats.tile,
    statTable: { ...dict.stats.table, sampleOnly: dict.stats.hud.sample },
    winrateGraph: {
      ...dict.stats.graph,
      hands: dict.stats.common.hands,
      handsHead: dict.stats.common.handsHead,
      bb: dict.stats.common.bb,
    },
    hands: locale === "hr" ? handsUiHr : handsUiEn,
    reports: locale === "hr" ? reportsUiHr : reportsUiEn,
  };
}

export const UI_STRINGS: Record<Locale, UiStrings> = { en: uiStrings("en"), hr: uiStrings("hr") };
