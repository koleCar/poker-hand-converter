/**
 * The Hands filter (moved to the shared package with the screen, R4.5b:
 * `@rail/ui/hands/filter`), and the app's hand-offs of a filter between its
 * screens: the Players screen's "hands with this player" (R2.7c), a saved
 * filter chosen in the command palette (R2.8).
 */
import type { FilterState } from "@rail/ui/hands/filter";

export * from "@rail/ui/hands/filter";

/** The screens a filter can be handed to. */
export type FilterTarget = "hands" | "reports";

/**
 * A filter a screen takes once. A screen not open yet takes it when it
 * mounts; an open one is told.
 */
const requested: Record<FilterTarget, FilterState | null> = { hands: null, reports: null };
const requestListeners = new Set<(target: FilterTarget) => void>();

/** Hand `filter` to a screen (go there next). */
export function requestFilter(filter: FilterState, target: FilterTarget = "hands"): void {
  requested[target] = filter;
  for (const listener of requestListeners) listener(target);
}

/** The filter asked for, once; `null` when none was. */
export function takeRequestedFilter(target: FilterTarget = "hands"): FilterState | null {
  const filter = requested[target];
  requested[target] = null;
  return filter;
}

/** Told when a filter is handed to a screen that may be open; returns the unsubscribe. */
export function onFilterRequested(listener: (target: FilterTarget) => void): () => void {
  requestListeners.add(listener);
  return () => requestListeners.delete(listener);
}
