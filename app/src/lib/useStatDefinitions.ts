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

import { inApp, ipc, type Definition } from "./ipc";

/** The rows and values of a `stats` list: the shared Reports screen's helpers (R4.5c). */
export { shownOf, statRows } from "@rail/ui/reports/definitions";

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
