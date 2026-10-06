/**
 * Manual hand entry: the betting pattern in a few words — what kind of pot it
 * is and who saw the flop — for the editor's summary line.
 */

import type { Position } from "../phf/types";
import type { EngineState } from "./engine";

export type PotType = "walk" | "limped" | "srp" | "threeBet" | "fourBet" | "fiveBet";

export interface BettingPattern {
  potType: PotType;
  /** Positions (or names, where a position is unknown) still in after preflop. */
  players: string[];
}

export function bettingPattern(state: EngineState): BettingPattern {
  const preflop = state.log.filter((entry) => entry.street === "preflop");
  const raises = preflop.filter((entry) => entry.kind === "raise").length;
  const calls = preflop.filter((entry) => entry.kind === "call").length;
  const potType: PotType =
    raises === 0
      ? calls > 0
        ? "limped"
        : "walk"
      : (["srp", "threeBet", "fourBet"] as const)[raises - 1] ?? "fiveBet";
  // The last preflop aggressor first: "BTN vs BB" reads as who raised whom.
  const aggressor = [...preflop].reverse().find((entry) => entry.kind === "raise")?.seat;
  const players = state.players
    .filter((player) => player.foldedStreet !== "preflop")
    .sort((a, b) => Number(b.seat === aggressor) - Number(a.seat === aggressor))
    .map((player) => label(player.position, player.name));
  return { potType, players };
}

function label(position: Position | null, name: string): string {
  return position ?? name;
}
