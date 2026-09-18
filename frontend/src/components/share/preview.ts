import { formatMoney } from "../../lib/format";
import type { ParsedHand } from "../../lib/handParser";
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

export function formatStakes(hand: Pick<ParsedHand, "currency" | "smallBlind" | "bigBlind">): string {
  return `${formatMoney(hand.currency, hand.smallBlind)}/${formatMoney(hand.currency, hand.bigBlind)}`;
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
export function buildSharePreview(hand: ParsedHand): SharePreview {
  const stakes = formatStakes(hand);
  const game = shortGameName(hand.gameLabel);
  const winners = hand.winners.map((winner) => ({ player: winner.player, amount: winner.amount }));
  const topWinner = topWinnerOf(winners);
  const pot = formatMoney(hand.currency, hand.totalPot);

  const title = `${stakes} ${game} — ${pot} pot | PokerConverter`;

  const parts: string[] = [`${hand.seats.length}-handed`];
  if (hand.board.length) {
    parts.push(`board ${hand.board.join(" ")}`);
  } else {
    parts.push("no flop");
  }
  if (topWinner) {
    parts.push(`${topWinner.player} wins ${formatMoney(hand.currency, topWinner.amount)}`);
  }
  parts.push(
    hand.wentToShowdown
      ? "shown down"
      : `decided on ${RANK_WORD[hand.streetReached] ?? hand.streetReached}`,
  );

  return {
    handId: hand.handId || null,
    gameType: hand.gameType,
    gameLabel: hand.gameLabel,
    stakes,
    currency: hand.currency,
    bigBlind: hand.bigBlind,
    tableName: hand.tableName,
    playedAt: hand.playedAt,
    playerCount: hand.seats.length,
    board: hand.board,
    winners,
    totalPot: hand.totalPot,
    heroName: hand.heroName,
    heroCards: hand.seats.find((seat) => seat.name === hand.heroName)?.cards ?? [],
    streetReached: hand.streetReached,
    wentToShowdown: hand.wentToShowdown,
    title,
    description: `${parts.join(" · ")}. Replay it action by action, free, on PokerConverter.`,
  };
}
