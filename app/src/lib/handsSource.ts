/**
 * The shared Hands screen's `HandsSource` (`@rail/ui/hands/model`, R4.5b)
 * over the Tauri commands into the local store (R2.7a): pages with the
 * store's keyset cursor, the chips' counts, the watcher's change event, the
 * store's saved filters. Tags and notes are the store's; the web's searches
 * and orders are not (yet).
 */
import type { HandCursor as AnyCursor, HandsSource, SavedFiltersSource } from "@rail/ui/hands/model";

import { ipc, onStatsDataChanged, type HandCursor } from "./ipc";

const savedFilters: SavedFiltersSource = {
  list: (screen) => ipc.savedFilters(screen),
  save: (name, filter, screen) => ipc.saveFilter(name, filter, screen),
  remove: (id, screen) => ipc.deleteSavedFilter(Number(id), screen),
};

export const storeHandsSource: HandsSource = {
  page: (filter, after: AnyCursor | null, limit) => ipc.handsPage(filter, after as HandCursor | null, limit),
  facets: (filter) => ipc.handsFacets(filter),
  onChanged: (listener) => onStatsDataChanged(listener),
  features: { annotations: true, search: false, sorts: [] },
  savedFilters,
};
