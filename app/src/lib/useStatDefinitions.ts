/**
 * The statistic definitions, read from the Rust side (`stat_definitions`):
 * the shipped ones (`config/stats/`, R2.4) in file order, then the user's own
 * (R2.10, `custom: true`) in their order - every `stats` list the report
 * commands return is in this order. A statistic's words are the definition's
 * own (`label`, `name`, `description` in `en` and `hr`). Read once, and again
 * after the user saves or deletes a statistic of their own
 * (`refreshStatDefinitions`).
 */
import { useEffect, useState } from "react";
import type { Shown, StatDefinition } from "@rail/ui/model/stats";
import type { StatTableRow } from "@rail/ui/stats/StatTable";

import type { Locale } from "../i18n";
import { inApp, ipc, type Definition } from "./ipc";

let cached: Promise<Definition[]> | null = null;
const listeners = new Set<() => void>();

/** The user's statistics changed: read the definitions again (every screen showing them re-renders). */
export function refreshStatDefinitions(): void {
  cached = null;
  for (const listener of listeners) listener();
}

/** The definitions, or `null` while they load (or outside the app). */
export function useStatDefinitions(): Definition[] | null {
  const [definitions, setDefinitions] = useState<Definition[] | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const listener = () => setGeneration((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
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
  }, [generation]);
  return definitions;
}

/**
 * `StatTable` rows: every definition `keep` keeps that has a value, in the
 * definitions' order. `stats` is in the definitions' order, or - with `ids`,
 * the definition id of each of `stats` - matched by id.
 */
export function statRows(
  definitions: readonly StatDefinition[],
  stats: readonly Shown[],
  locale: Locale,
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
