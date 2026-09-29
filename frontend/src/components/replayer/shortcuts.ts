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
 */

export interface Shortcut {
  /** Keys as the reader sees them, e.g. `["←", "→"]`. */
  keys: string[];
  description: string;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ["←", "→"], description: "Step back / forward one action" },
  { keys: ["Space"], description: "Play / pause" },
  { keys: ["Home", "End"], description: "Jump to the start / the award" },
  { keys: ["1", "…", "5"], description: "Jump to a street" },
  { keys: ["B"], description: "Chips in big blinds" },
  { keys: ["C"], description: "Show every card the history knows" },
  { keys: ["H"], description: "Show hero’s hole cards" },
  { keys: ["L"], description: "Action log" },
  { keys: ["I"], description: "Hand info" },
  { keys: ["?"], description: "This sheet" },
  { keys: ["Esc"], description: "Close the open sheet" },
];
