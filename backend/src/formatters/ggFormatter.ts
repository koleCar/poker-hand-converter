import type { ParsedHand } from "../domain/types.js";

export function formatHandsAsGg(hands: ParsedHand[]): string {
  return hands.map((hand) => hand.lines.join("\n")).join("\n\n");
}
