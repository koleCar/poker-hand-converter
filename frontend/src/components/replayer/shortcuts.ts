/**
 * The replayer's keyboard map, written down once.
 *
 * `ReplayViewer.onKeyDown` implements it and `ShortcutSheet` prints it; they
 * are meant to be read side by side, and a key added to one without the other
 * is a bug in whichever half was skipped.
 *
 * Every entry works only while the replayer has focus — the handler is scoped
 * to the root, not to `window`, so two replayers on one page do not both
 * answer, and typing `b` in a comment box does not switch anybody's units.
 *
 * The descriptions are in the dictionary (`replayer.keys.items`), filed under
 * each entry's `id`.
 */

import type { Dict } from "../../lib/i18n/types";

/** The key a description is filed under in `replayer.keys.items`. */
export type ShortcutId = keyof Dict["replayer"]["keys"]["items"];

/** Marks the space bar, whose cap is named in the reader's language. */
export const SPACE_KEY = "Space";

export interface Shortcut {
  /**
   * Keys as the reader sees them, e.g. `["←", "→"]`. Key caps, so the same in
   * every language — except `SPACE_KEY`, which `ShortcutSheet` translates.
   */
  keys: string[];
  id: ShortcutId;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["←", "→"], id: "step" },
  { keys: [SPACE_KEY], id: "play" },
  { keys: ["Home", "End"], id: "ends" },
  { keys: ["1", "…", "5"], id: "streets" },
  { keys: ["B"], id: "bigBlinds" },
  { keys: ["C"], id: "knownCards" },
  { keys: ["H"], id: "heroCards" },
  { keys: ["L"], id: "log" },
  { keys: ["I"], id: "info" },
  { keys: ["F"], id: "fullScreen" },
  { keys: ["?"], id: "help" },
  { keys: ["Esc"], id: "close" },
];
