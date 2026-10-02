/**
 * The feed card — the replayer's third mode, and the only one that is not the
 * replayer.
 *
 * ## It builds no frames, and that is the entire design constraint
 *
 * `buildReplay` walks every action in a hand and materialises a complete
 * snapshot of the table per action: seats, stacks, bets, pots, boards. That is
 * the right cost for *one* hand you are about to watch and an absurd one for a
 * feed, where twenty-five of them are on screen and twenty-four will never be
 * opened. So this component does not import `lib/replay` at all — not the
 * function, not the types. There is no frame state here to be tempted into
 * filling, which is a stronger guarantee than a promise not to call it.
 *
 * Everything on the card is read straight off the `PhfHand`: the stakes, the
 * game, how many players, the board, the focused player's cards and position.
 * All of it is knowable before the first action and none of it needs a replay.
 *
 * ## It is visually continuous with the replayer by construction
 *
 * The cards are `PlayingCard`, the position chip is the felt's own
 * `.pseat__pos`, and the labels come from `handFacts`. Not "styled to match" —
 * *the same elements*, so the card cannot drift away from the thing it opens.
 *
 * ## It does not spoil the hand
 *
 * A card in a feed is at frame zero by definition, and #23's rule is that
 * anything derived from `hand.results` is gated on frame position. There is no
 * frame here to gate on, so the gate is the `spoilers` prop and it is **off by
 * default**: no pot, no winner, no "shown down". A forum whose core interaction
 * is "what would you do?" cannot answer the question in the thumbnail.
 */

import { useDict } from "../../lib/i18n/client";
import { primaryBoard, formatAmount, type PhfHand } from "../../lib/phf/types";
import { gameLabel, stakesLabel } from "./handFacts";
import { PlayingCard } from "./PlayingCard";
import { spokenPosition } from "./tableMath";

export interface ReplayCardProps {
  hand: PhfHand;
  /**
   * Seat whose hole cards and position the card shows. Defaults to the hero —
   * a forum post about somebody else's spot says whose spot it is.
   */
  focusSeat?: number | null;
  /**
   * Show numbers derived from `hand.results` — the pot, in practice. Off by
   * default; see the note at the top of this file and #23.
   */
  spoilers?: boolean;
  /** Turns the card into a button. Omit for a card inside an existing link. */
  onOpen?: () => void;
  className?: string;
}

/** Up to five board slots, so a preflop card is the same height as a river one. */
const BOARD_SLOTS = 5;

export function ReplayCard({
  hand,
  focusSeat = null,
  spoilers = false,
  onOpen,
  className = "",
}: ReplayCardProps) {
  const t = useDict().replayer;
  const words = t.card;
  const focus =
    (focusSeat !== null ? hand.players.find((player) => player.seat === focusSeat) : null) ??
    hand.players.find((player) => player.isHero) ??
    null;

  const board = primaryBoard(hand);
  const dealtIn = hand.players.filter((player) => !player.sittingOut).length;
  const stakes = stakesLabel(hand);
  const game = gameLabel(hand, t);
  const focusPosition = focus ? spokenPosition(focus.position, t) : null;

  const label = [
    `${stakes} ${game}`,
    words.handed(dealtIn),
    focus && focusPosition ? words.focus(focus.name, focusPosition) : null,
    board.length ? words.board(board.join(" ")) : words.noFlop,
  ]
    .filter(Boolean)
    .join(", ");

  const body = (
    <>
      <span className="rcard__head">
        <span className="rcard__stakes">{stakes}</span>
        <span className="rcard__game">{game}</span>
        <span className="rcard__seats">{words.handed(dealtIn)}</span>
      </span>

      <span className="rcard__hand">
        {focus?.position ? (
          <span className="pseat__pos" title={focusPosition ?? undefined}>
            {focus.position}
          </span>
        ) : null}
        <span className="rcard__cards">
          {(focus?.holeCards.length ? focus.holeCards : [null, null]).map((code, index) => (
            <PlayingCard key={`hole-${index}-${code ?? "back"}`} code={code} size="sm" />
          ))}
        </span>
      </span>

      {/* Five slots whatever the street, so a feed of cards does not jitter by
          a card's height between a preflop fold and a river showdown. */}
      <span className="rcard__board">
        {Array.from({ length: BOARD_SLOTS }, (_, index) =>
          board[index] ? (
            <PlayingCard key={`board-${index}`} code={board[index]} size="xs" />
          ) : (
            <span key={`board-slot-${index}`} className="rcard__board-slot" />
          ),
        )}
      </span>

      <span className="rcard__foot">
        {/* The one line on this card that could come from `hand.results`. */}
        {spoilers ? (
          <span className="rcard__pot">
            {words.pot(formatAmount(hand.results.totalPot, hand.game.unit, "minimal", true))}
          </span>
        ) : (
          <span className="rcard__pot rcard__pot--hidden" aria-hidden="true" />
        )}
        <span className="rcard__play" aria-hidden="true">
          ▶
        </span>
      </span>
    </>
  );

  const classes = `rcard ${className}`.trim();

  if (!onOpen) {
    return (
      <span className={classes} role="img" aria-label={label}>
        {body}
      </span>
    );
  }

  return (
    <button type="button" className={classes} onClick={onOpen} aria-label={words.replay(label)}>
      {body}
    </button>
  );
}
