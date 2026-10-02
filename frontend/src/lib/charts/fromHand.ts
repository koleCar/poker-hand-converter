/**
 * A parsed hand (`PhfHand`) into the `PreflopSpot` of one hero decision.
 *
 * Reads only the action stream, the players and the game header - the same
 * rule as `lib/stats/context.ts`: straddles and antes are detected from the
 * stream, not from `game.straddles` / `game.anteModel`, which most parsers
 * leave at their defaults.
 */

import { assignPositions, isPostingAction, type PhfHand, type Position } from "../phf/types";
import type { PreflopActionInput, PreflopSpot } from "./lookup";
import { CHART_SETS, pickChartSet, type ChartSetSpec } from "./registry";

export type SpotFromHandResult =
  | {
      ok: true;
      spot: PreflopSpot;
      /** The hero's decision itself. */
      heroAction: PreflopActionInput;
      /** Hole cards, when known. */
      heroCards: string[] | null;
      /** Index of the decision in `hand.actions`. */
      actionIndex: number;
    }
  | { ok: false; reason: "game" | "bomb-pot" | "no-positions" | "no-hero" | "no-decision"; detail: string };

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);

/**
 * The spot for the hero's `nth` preflop decision (0 = the first). `heroSeat`
 * defaults to the player marked as hero. Does not mutate `hand`.
 */
export function preflopSpotFromHand(hand: PhfHand, nth = 0, heroSeat?: number): SpotFromHandResult {
  const game = hand.game;
  if (game.variant !== "holdem" || game.limit !== "nl" || game.format !== "cash") {
    return { ok: false, reason: "game", detail: `${game.variant} ${game.limit} ${game.format} is not NLHE cash` };
  }
  if (hand.actions.some((a) => a.type === "bomb-ante")) {
    return { ok: false, reason: "bomb-pot", detail: "bomb pot: no preflop betting" };
  }

  // Positions, without touching the caller's hand.
  let players = hand.players;
  if (players.every((p) => p.position === null)) {
    const copy: PhfHand = { ...hand, players: hand.players.map((p) => ({ ...p })) };
    assignPositions(copy);
    players = copy.players;
  }
  const position = new Map<number, Position>();
  for (const p of players) {
    if (p.position) position.set(p.seat, p.position);
  }
  if (!position.size) {
    return { ok: false, reason: "no-positions", detail: "button unknown; positions cannot be resolved" };
  }

  const heroPlayer = heroSeat === undefined ? players.find((p) => p.isHero) : players.find((p) => p.seat === heroSeat);
  if (!heroPlayer || !position.has(heroPlayer.seat)) {
    return { ok: false, reason: "no-hero", detail: "no hero seat with a position" };
  }

  const bb = game.bigBlind;
  const actions: PreflopActionInput[] = [];
  let seen = 0;
  for (const action of hand.actions) {
    if (action.street !== "preflop" || action.seat === null) continue;
    if (isPostingAction(action.type) || !DECISIONS.has(action.type)) continue;
    const pos = position.get(action.seat);
    if (!pos) continue;
    const input: PreflopActionInput = {
      position: pos,
      type: action.type === "bet" ? "raise" : (action.type as PreflopActionInput["type"]),
    };
    if (action.type === "call" || action.type === "raise" || action.type === "bet") {
      input.toBb = action.streetTotal / bb;
    }
    if (action.allIn) input.allIn = true;
    if (action.seat === heroPlayer.seat) {
      if (seen === nth) {
        const stacksBb: Partial<Record<Position, number>> = {};
        for (const p of players) {
          const at = position.get(p.seat);
          if (at) stacksBb[at] = p.startingStack / bb;
        }
        const cards = heroPlayer.holeCards.length === 2 ? [...heroPlayer.holeCards] : null;
        return {
          ok: true,
          spot: {
            positions: [...position.values()],
            hero: position.get(heroPlayer.seat) as Position,
            actions,
            stacksBb,
            ante: hand.actions.some((a) => a.type === "ante"),
            straddle: hand.actions.some((a) => a.type === "straddle"),
          },
          heroAction: input,
          heroCards: cards,
          actionIndex: action.index,
        };
      }
      seen += 1;
    }
    actions.push(input);
  }
  return { ok: false, reason: "no-decision", detail: `the hero has no preflop decision #${nth}` };
}

/**
 * The ids of the library sets a hand needs: one per table and depth its
 * players' preflop decisions are looked up at - the hero's, graded, and every
 * opponent's, whose chart ranges the postflop analysis starts from. A caller
 * loads these (`ensureChartSets`) before analysing the hand, since the lookup
 * itself is synchronous.
 */
export function requiredChartSets(hand: PhfHand, specs: readonly ChartSetSpec[] = CHART_SETS): string[] {
  const out = new Set<string>();
  for (const player of hand.players) {
    for (let nth = 0; ; nth += 1) {
      const found = preflopSpotFromHand(hand, nth, player.seat);
      if (!found.ok) break;
      if (found.spot.straddle || found.spot.ante) return [];
      const pick = pickChartSet(specs, found.spot);
      if (pick.ok) out.add(pick.spec.id);
    }
  }
  return [...out].sort();
}
