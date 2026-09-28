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

export function formatPlayedAt(iso: string | null): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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

/**
 * Denormalised hand summary. Kept free of React so the same shape can be sent
 * to the backend and reused for OG meta without re-parsing the hand text.
 */
export function buildSharePreview(hand: PhfHand): SharePreview {
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

  const title = `${stakes} ${game} — ${pot} pot | Rail`;

  const parts: string[] = [`${hand.players.length}-handed`];
  if (board.length) {
    parts.push(`board ${board.join(" ")}`);
  } else {
    parts.push("no flop");
  }
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
    title,
    description: `${parts.join(" · ")}. Replay it action by action, free, on Rail.`,
  };
}
