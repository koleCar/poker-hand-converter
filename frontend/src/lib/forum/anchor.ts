/**
 * What an anchored comment says it is about — "turn, after BB raises to $12".
 *
 * Computed from the anchor plus the post's published document, on the server,
 * so the chip is real text in the HTML. Pure: no DOM, no environment.
 *
 * The anchor is `PhfAction.index` (see `components/replayer/position.ts` for
 * why never a frame index). Resolution is the same lossy-tolerant rule the
 * replayer uses: the first action at or after the stored index, so a parser fix
 * that shifts indices lands the chip one action late rather than nowhere.
 */

import type { PhfHand } from "../phf/types";

const STREET_WORD: Record<string, string> = {
  preflop: "preflop",
  flop: "flop",
  turn: "turn",
  river: "river",
  showdown: "showdown",
};

export interface AnchorLike {
  actionIndex: number | null;
  street: string | null;
  seat?: number | null;
}

/**
 * `after` joins the street to the action. The reader's dictionary passes its
 * own (`forum.anchorAfter`); street names and the hand's action text are poker
 * terms and the source's own words, and stay as they are.
 */
export function anchorLabel(
  hand: PhfHand | null | undefined,
  anchor: AnchorLike | null | undefined,
  after: (where: string, what: string) => string = (where, what) => `${where}, after ${what}`,
): string | null {
  if (!anchor) {
    return null;
  }
  const street = anchor.street ? STREET_WORD[anchor.street] ?? null : null;
  if (!hand || anchor.actionIndex === null || anchor.actionIndex === undefined) {
    return street;
  }
  const action = hand.actions.find((candidate) => candidate.index >= anchor.actionIndex!);
  if (!action) {
    return street;
  }
  const where = STREET_WORD[action.street] ?? action.street;
  const who = action.player || "";
  return after(where, `${who} ${action.label}`.trim());
}
