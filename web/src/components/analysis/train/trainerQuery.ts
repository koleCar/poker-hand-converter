/**
 * The web Trainer's opening settings (`WebTrainer.tsx`). Pure, apart from the
 * page so the tests can hold it.
 */

import { parseSettings, type TrainerSettings } from "../../trainer/settings";

/**
 * The settings to open with: an address that names a mode (a leak's or the
 * study plan's trainer link, `targetQuery`) wins for the spot; how the
 * trainer behaves (pause, shown panels) is always this browser's.
 */
export function initialSettings(query: Record<string, string | string[] | undefined>, stored: Record<string, unknown> | null): TrainerSettings {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) flat[key] = Array.isArray(value) ? value[0] : value;
  const saved = parseSettings(stored);
  if (typeof flat.mode !== "string") return saved;
  const fromAddress = parseSettings(flat);
  return { ...fromAddress, pause: saved.pause, strategy: saved.strategy, facts: saved.facts };
}
