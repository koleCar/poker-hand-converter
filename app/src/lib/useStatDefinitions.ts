/**
 * The shipped statistic definitions (`config/stats/`, R2.4), read once from
 * the Rust side (`stat_definitions`): every `stats` list the report commands
 * return is in this order. A statistic's words are the definition's own
 * (`label`, `name`, `description` in `en` and `hr`).
 */
import { useEffect, useState } from "react";
import type { Shown, StatDefinition } from "@rail/ui/model/stats";
import type { StatTableRow } from "@rail/ui/stats/StatTable";

import type { Locale } from "../i18n";
import { inApp, ipc } from "./ipc";

let cached: Promise<StatDefinition[]> | null = null;

/** The definitions, or `null` while they load (or outside the app). */
export function useStatDefinitions(): StatDefinition[] | null {
  const [definitions, setDefinitions] = useState<StatDefinition[] | null>(null);
  useEffect(() => {
    if (!inApp) return;
    let live = true;
    cached ??= ipc.statDefinitions().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    cached
      .then((list) => {
        if (live) setDefinitions(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return definitions;
}

/** `StatTable` rows: the definitions with these ids (all, in file order, when `ids` is absent), each with its value. */
export function statRows(
  definitions: readonly StatDefinition[],
  stats: readonly Shown[],
  locale: Locale,
  keep: (definition: StatDefinition) => boolean = () => true,
): StatTableRow[] {
  const rows: StatTableRow[] = [];
  definitions.forEach((definition, index) => {
    const shown = stats[index];
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

/** The value of definition `id` in a list in `definitions`' order. */
export function shownOf(
  definitions: readonly StatDefinition[],
  stats: readonly Shown[],
  id: string,
): { definition: StatDefinition; shown: Shown } | null {
  const index = definitions.findIndex((definition) => definition.id === id);
  const shown = index < 0 ? undefined : stats[index];
  const definition = definitions[index];
  return shown && definition ? { definition, shown } : null;
}
