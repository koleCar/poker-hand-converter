import type { UiStrings } from "@rail/ui/i18n";
import { replayerEn } from "@rail/ui/strings/replayer.en";
import { replayerHr } from "@rail/ui/strings/replayer.hr";
import { statsUiEn } from "@rail/ui/strings/stats.en";
import { statsUiHr } from "@rail/ui/strings/stats.hr";

import { en } from "./en";
import { hr } from "./hr";
import { INTL_LOCALE, type Dict, type Locale } from "./types";

/** The package's statistics words in one language (`packages/ui/strings/stats.*.ts`). */
type StatsUi = typeof statsUiEn | typeof statsUiHr;

/**
 * The strings the shared UI package's components read (`packages/ui/i18n.tsx`):
 * the replayer's (R2.7a) and the statistics' (the tile, the table and the
 * win-rate graph, R2.7b) are the package's own dictionaries
 * (`packages/ui/strings/`, the words the web shows); the close label and the
 * graph's "not enough hands" (the web's says "keep uploading") come from this
 * app's dictionaries. Built once per language; `I18nProvider` mounts them.
 */
function uiStrings(locale: Locale, dict: Dict, replayer: UiStrings["replayer"], stats: StatsUi): UiStrings {
  return {
    intlLocale: INTL_LOCALE[locale],
    closeNamed: dict.ui.closeNamed,
    replayer,
    statTile: stats.tile,
    statTable: { ...stats.table, sampleOnly: stats.sampleOnly },
    winrateGraph: {
      ...stats.graph,
      notEnough: dict.reports.graph.notEnough,
      hands: stats.hands,
      handsHead: stats.handsHead,
      bb: stats.bb,
    },
    hands: dict.hands,
    reports: dict.reports,
  };
}

export const UI_STRINGS: Record<Locale, UiStrings> = {
  en: uiStrings("en", en, replayerEn, statsUiEn),
  hr: uiStrings("hr", hr, replayerHr, statsUiHr),
};
