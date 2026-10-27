import {
  formatAmount,
  primaryBoard,
  toDisplayNumber,
  type Amount,
  type PhfGame,
  type PhfHand,
} from "../../lib/phf/types";
import type { SharePreview } from "./shareContract";

const RANK_WORD: Record<string, string> = {
  preflop: "preflop",
  flop: "the flop",
  turn: "the turn",
  river: "the river",
  showdown: "showdown",
};

/** "Hold'em No Limit ($0.25/$0.5)" -> "Hold'em No Limit". */
export function shortGameName(gameLabel: string): string {
  return gameLabel.replace(/\s*\([^)]*\)\s*$/, "").trim() || "Poker";
}

export function formatStakes(hand: { game: Pick<PhfGame, "unit" | "smallBlind" | "bigBlind"> }): string {
  const { unit, smallBlind, bigBlind } = hand.game;
  return `${formatAmount(smallBlind, unit)}/${formatAmount(bigBlind, unit)}`;
}

export function formatPlayedAt(iso: string | null, intl: string = "en-GB"): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString(intl, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Biggest winner, summing per player first.
 *
 * A split main/side pot is reported as one collect each, so the raw list can
 * hold two rows for the same player; taking the max of those would understate
 * what they actually won.
 */
export function topWinnerOf(
  winners: Array<{ player: string; amount: number }>,
): { player: string; amount: number } | null {
  const byPlayer = new Map<string, number>();
  for (const winner of winners) {
    byPlayer.set(winner.player, (byPlayer.get(winner.player) ?? 0) + winner.amount);
  }
  let best: { player: string; amount: number } | null = null;
  for (const [player, amount] of byPlayer) {
    if (!best || amount > best.amount) {
      best = { player, amount };
    }
  }
  return best;
}

export interface SharePreviewOptions {
  /**
   * Let the copy say how the hand ended. **Off by default, and that default is
   * the feature** — see the note on `buildSharePreview`.
   */
  spoilers?: boolean;
}

/**
 * Denormalised hand summary. Kept free of React so the same shape can be sent
 * to the backend and reused for OG meta without re-parsing the hand text.
 *
 * ## The description does not give the hand away
 *
 * It used to end `… · Villain wins $312 · shown down`, which Slack, Discord,
 * Twitter and iMessage then printed under the link. For a product whose core
 * interaction is "what would you do here?", that is the answer key in the
 * preview: the post is finished before anybody opens it. #23.
 *
 * The rule is the one `spoilersRevealed()` states for the replayer — *anything
 * derived from `hand.results` is gated* — applied to the one surface that has
 * no frame position to gate on. A link unfurl is permanently at frame zero, so
 * the gate is this flag and it is closed unless the sharer opened it. What is
 * left is everything knowable before a card is dealt, plus the board, which is
 * the hand's subject rather than its outcome:
 *
 *     6-handed $0.25/$0.5 NL Hold'em · board Ah Kd 7c
 *
 * `winners` / `totalPot` stay on the returned shape either way. They are read
 * by the share *page*, which has a replay to gate them against; the flag only
 * governs `title` and `description`, which are the two fields that leave it.
 */
export function buildSharePreview(
  hand: PhfHand,
  options: SharePreviewOptions = {},
): SharePreview {
  const spoilers = options.spoilers === true;
  const unit = hand.game.unit;
  const display = (amount: Amount) => toDisplayNumber(amount, unit);
  const stakes = formatStakes(hand);
  const game = shortGameName(hand.game.label);
  const board = primaryBoard(hand);
  const hero = hand.players.find((player) => player.isHero) ?? null;
  // The contract is a wire shape read by the OG renderer, so it stays in
  // display units; the arithmetic that produced them was integer.
  const winners = hand.results.winners.map((winner) => ({
    player: winner.player,
    amount: display(winner.amount),
  }));
  const topWinner = topWinnerOf(winners);
  const pot = formatAmount(hand.results.totalPot, unit, "minimal", true);

  // The pot is `hand.results.totalPot`, so the title is gated too: "$312 pot"
  // in a headline tells a reader the hand got big, which is most of what the
  // winner line told them. Seat count replaces it — knowable at the deal.
  const title = spoilers
    ? `${stakes} ${game} — ${pot} pot | Rail`
    : `${stakes} ${game} — ${hand.players.length}-handed | Rail`;

  const parts: string[] = [`${hand.players.length}-handed ${stakes} ${game}`];
  parts.push(board.length ? `board ${board.join(" ")}` : "no flop");
  if (spoilers) {
    if (topWinner) {
      parts.push(
        `${topWinner.player} wins ${formatAmount(
          Math.round(topWinner.amount * unit.minorUnits),
          unit,
          "minimal",
          true,
        )}`,
      );
    }
    parts.push(
      hand.results.wentToShowdown
        ? "shown down"
        : `decided on ${RANK_WORD[hand.results.streetReached] ?? hand.results.streetReached}`,
    );
  }

  return {
    handId: hand.meta.handId || null,
    gameType: hand.game.format === "cash" ? "cash" : "tournament",
    gameLabel: hand.game.label,
    stakes,
    currency: unit.symbol,
    bigBlind: display(hand.game.bigBlind),
    tableName: hand.table.name,
    playedAt: hand.playedAt,
    playerCount: hand.players.length,
    board,
    winners,
    totalPot: display(hand.results.totalPot),
    heroName: hero?.name ?? null,
    heroCards: hero?.holeCards ?? [],
    streetReached: hand.results.streetReached,
    wentToShowdown: hand.results.wentToShowdown,
    spoilers,
    title,
    description: `${parts.join(" · ")}. Replay it action by action, free, on Rail.`,
  };
}
