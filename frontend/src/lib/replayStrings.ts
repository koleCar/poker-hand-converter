/**
 * The words `buildReplay` writes onto its frames: the captions ("Hole cards
 * dealt", "Alice wins $12"), the action pills under a seat ("raises to $6"),
 * and the names of the piles in the middle.
 *
 * Pure TypeScript on purpose. `lib/replay.ts` is imported by the test harness
 * and by server code, so it cannot reach for React or the i18n provider; it
 * takes one of these objects instead and defaults to the English one below.
 * The replayer passes `useDict().replayer.frames`, which is this same shape in
 * the reader's language (`lib/i18n/ns/replayer.*.ts`).
 *
 * Everything that comes out of the hand itself — player names, card codes,
 * amounts, the room's own hand descriptions — arrives already formatted and is
 * placed into the sentence, never translated.
 */

import type { Amount, PhfAction, Street } from "./phf/types";

export interface ReplayStrings {
  /** Caption of the `deal` frame. */
  holeCardsDealt: string;
  /** Caption of the frame that sweeps a street's bets into the middle. */
  chipsToPot: string;
  /** Caption of a `street` frame: the street and the board so far. */
  street: (street: Street, board: string[]) => string;
  /**
   * The pill under a seat for a blind, ante, straddle, call, bet or raise.
   * `money` formats an amount in the hand's own currency.
   */
  actionLabel: (action: PhfAction, money: (amount: Amount) => string) => string;
  /** The same pill when the action put the player all-in. */
  allIn: (label: string) => string;
  /** Pills for the actions that carry no amount. */
  foldLabel: string;
  checkLabel: string;
  showsLabel: string;
  mucksLabel: string;
  /** Caption for an action with a pill: blinds, calls, bets, raises. */
  acted: (player: string, label: string) => string;
  folds: (player: string) => string;
  checks: (player: string) => string;
  /** `description` is the room's own words for the hand, e.g. "a pair of Aces". */
  shows: (player: string, cards: string[], description: string | null) => string;
  mucks: (player: string) => string;
  /** An uncalled bet going back; `amount` is already formatted. */
  uncalled: (player: string, amount: string) => string;
  /** One winner of one pot; `amount` is already formatted. */
  wins: (player: string, amount: string) => string;
  /**
   * Caption of an award frame when the hand had more than one pot. `pot` is
   * the frame's own pile name (`Main`, `Side`, `Side 2`…), `winners` the
   * already-joined `wins` lines.
   */
  potAward: (pot: string, winners: string) => string;
  /**
   * A pile name as shown on the felt. Frames keep the canonical English name
   * (`Pot`, `Main`, `Side`, `Side 2`, or whatever the room printed) because
   * code and tests key on it; this is only the label.
   */
  potName: (name: string) => string;
  /** Caption of the last frame of a hand that paid nobody. */
  endOfHand: string;
}

/**
 * English, and the default. The action pills are the source's own wording
 * (`PhfAction.label`, "raises to $6"), which is what the replayer has always
 * printed, so an English caption is byte-for-byte what it was before there
 * was a choice of language.
 */
export const ENGLISH_REPLAY_STRINGS: ReplayStrings = {
  holeCardsDealt: "Hole cards dealt",
  chipsToPot: "Chips to the pot",
  street: (street, board) => `${street.toUpperCase()} ${board.join(" ")}`,
  actionLabel: (action) => action.label,
  allIn: (label) => `${label} · all-in`,
  foldLabel: "fold",
  checkLabel: "check",
  showsLabel: "shows",
  mucksLabel: "mucks",
  acted: (player, label) => `${player} ${label}`,
  folds: (player) => `${player} folds`,
  checks: (player) => `${player} checks`,
  shows: (player, cards, description) =>
    `${player} shows ${cards.join(" ")}${description ? ` (${description})` : ""}`,
  mucks: (player) => `${player} mucks`,
  uncalled: (player, amount) => `Uncalled ${amount} returned to ${player}`,
  wins: (player, amount) => `${player} wins ${amount}`,
  potAward: (pot, winners) => `${pot} pot — ${winners}`,
  potName: (name) => name,
  endOfHand: "End of hand",
};
