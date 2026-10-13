/**
 * The shipped display definitions (`config/stats/standard.json`), compiled
 * once at module load.
 *
 * `definitions.json` next to this file is a byte-for-byte copy of
 * `config/stats/standard.json`, the one source the desktop app and the HUD
 * read too (`rail_config::stats::SHIPPED_STATS`). It is a copy because the web
 * is built from `frontend/` alone; `tests/test/statDisplay.test.ts` fails when
 * the two differ (copy the file over and commit both).
 *
 * Strings shown to users come from the definition itself (`label`, `name`,
 * `description`, one per locale), not from `lib/i18n`: the HUD reads them in
 * Rust without a JavaScript dictionary, and a user's own statistic (R2.10)
 * carries the words its author typed. `localized(def.label, locale)` picks one.
 */

import standard from "./definitions.json";
import { compileStats, type DisplayStat, type StatText, type StatsFile } from "./display";

/** Every shipped definition, in file order. */
export const STANDARD_STATS: readonly DisplayStat[] = compileStats(standard as StatsFile);

/** A definition's string in `locale`, English for a locale it lacks. */
export function localized(text: StatText, locale: string): string {
  return locale === "hr" ? text.hr : text.en;
}
