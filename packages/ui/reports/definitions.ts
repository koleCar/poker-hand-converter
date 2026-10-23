/**
 * The statistics' rows and values as the Reports screen lists them: the
 * definitions (`config/stats/`, R2.4, and on the desktop the user's own,
 * R2.10) matched to a `Shown` list. Moved from the desktop app
 * (`app/src/lib/useStatDefinitions.ts`, which re-exports them, R4.5c).
 */
import type { Shown, StatDefinition, StatText } from "../model/stats";
import type { StatTableRow } from "../stats/StatTable";

/** A definition's words in the reader's language (`StatText` has `en` and `hr`). */
export type TextLocale = keyof StatText;

/** The `StatText` key for a BCP 47 tag (`hr-HR` -> `hr`; anything else English). */
export function textLocale(intlLocale: string): TextLocale {
  return intlLocale.toLowerCase().startsWith("hr") ? "hr" : "en";
}

/**
 * `StatTable` rows: every definition `keep` keeps that has a value, in the
 * definitions' order. `stats` is in the definitions' order, or - with `ids`,
 * the definition id of each of `stats` - matched by id.
 */
export function statRows(
  definitions: readonly StatDefinition[],
  stats: readonly Shown[],
  locale: TextLocale,
  keep: (definition: StatDefinition) => boolean = () => true,
  ids?: readonly string[],
): StatTableRow[] {
  const rows: StatTableRow[] = [];
  definitions.forEach((definition, index) => {
    const shown = ids ? stats[ids.indexOf(definition.id)] : stats[index];
    if (shown && keep(definition)) {
      rows.push({
        id: definition.id,
        label: definition.name[locale],
        description: definition.description[locale],
        unit: definition.format.unit,
        shown,
      });
    }
  });
  return rows;
}

/** The value of definition `id` in a list in `definitions`' order, or - with `ids` - matched by id. */
export function shownOf(
  definitions: readonly StatDefinition[],
  stats: readonly Shown[],
  id: string,
  ids?: readonly string[],
): { definition: StatDefinition; shown: Shown } | null {
  const index = definitions.findIndex((definition) => definition.id === id);
  const shown = index < 0 ? undefined : ids ? stats[ids.indexOf(id)] : stats[index];
  const definition = definitions[index];
  return shown && definition ? { definition, shown } : null;
}
