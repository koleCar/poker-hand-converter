/**
 * The shared Players screen's `PlayersSource` (`@rail/ui/players/model`,
 * R4.5c) over the Tauri commands into the local store (R2.7c): the list, a
 * profile, the rooms, the labels in use, the user's words (a colour, labels
 * and a note: all three, kept on this computer), and the watcher's change
 * event.
 */
import type { PlayersSource } from "@rail/ui/players/model";

import { ipc, onStatsDataChanged } from "./ipc";

export const storePlayersSource: PlayersSource = {
  features: { colours: true, labels: true },
  list: (query) => ipc.playersList(query),
  profile: (site, player, kind) => ipc.playerProfile(site, player, kind),
  sites: () => ipc.playerSites(),
  labels: () => ipc.playerLabels(),
  setNote: (site, player, note) => ipc.playerSetNote(site, player, note),
  setColour: (site, player, colour) => ipc.playerSetColour(site, player, colour),
  addLabel: (site, player, label) => ipc.playerAddLabel(site, player, label),
  removeLabel: (site, player, label) => ipc.playerRemoveLabel(site, player, label),
  onChanged: (listener) => onStatsDataChanged(listener),
};
