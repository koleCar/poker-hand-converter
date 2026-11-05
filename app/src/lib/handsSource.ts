/**
 * The shared Hands screen's `HandsSource` (`@rail/ui/hands/model`, R4.5b)
 * over the Tauri commands into the local store (R2.7a): pages with the
 * store's keyset cursor, the chips' counts, the watcher's change event, the
 * store's saved filters. Tags and notes are the store's; the web's searches,
 * orders and other filters are not (yet).
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
  // The searches (hero hand, board - cards or ranks -, a player by name,
  // showdown) and every column's order are the store's since 2026-11-05
  // (`hand_list::search_clauses`, `hand_list::SORTS`). The web library's
  // other filters (table, minimum pot, showdown positions, names) are not.
  features: {
    annotations: true,
    search: true,
    sorts: ["oldest", "pot", "potAsc", "won", "lost", "stakes", "stakesAsc", "position", "positionDesc"],
    more: [],
    // The filter builder's groups (V1, 2026-11-05): the hero's actions, the
    // flop's texture, players and conditions, time, ranges, the analysis.
    builder: true,
  },
  savedFilters,
  // The date's session picker: the latest 50, a 30-minute break apart.
  sessions: (kind) => ipc.reviewSessions(30, null, 50, kind),
};
