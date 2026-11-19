/**
 * The Analysis screen's Multiway and Bomb pots tabs (analysis/45, design
 * `ideas-potkinds` variant C): what they show, as each surface hands it in.
 * The web reads it from Supabase (`web/src/lib/db/potKinds.ts`), the app
 * from its store (`app/src/screens/analysis/PotKinds.tsx`); the bomb pots'
 * sums come from `bombSummary` (`web/src/lib/analysis/potKinds.ts`), whose
 * result has this `BombSummary` shape.
 */

/** A count of chances and of the times it happened. */
export interface Rate {
  n: number;
  hits: number;
}

export type FirstMove = "bet" | "check" | "call" | "raise" | "fold";
export type BetSize = "small" | "half" | "big";

export interface BombSummary {
  hands: number;
  netBb: number;
  showdownBb: number;
  nonShowdownBb: number;
  byAnte: { anteBb: number; hands: number; netBb: number }[];
  byFirstMove: { move: FirstMove; hands: number; netBb: number }[];
  habits: Record<"betFlop" | "foldFlop" | "betTurn" | "betRiver", { hero: Rate; pool: Rate }>;
  foldThrough: Record<BetSize, Rate>;
}

/** The multiway hands' sums. */
export interface MultiwaySummary {
  hands: number;
  /** Thousandths of a big blind. */
  netBbMilli: number;
  showdownBbMilli: number;
  nonShowdownBbMilli: number;
  decisions: number;
  graded: number;
  /** Perfect, Good, Inaccurate, Mistake, Blunder. */
  grades: number[];
  byPlayers: { players: number; decisions: number; graded: number; off: number; evLossBb: number }[];
}

/** A decision graded Inaccurate or worse, worth a second look. */
export interface PotKindDecision {
  /** The hand: its store key (app) or row id (web). */
  handKey: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  street: string;
  action: string;
  scenario: string;
  grade: string;
  evLossBb: number;
  /** The hero's cards, space-separated ("Ah Kd"). */
  heroCards: string | null;
  position: string | null;
  players: number | null;
}

export type PotKind = "mw" | "bomb";

/** The share of the pot a pure bluff of this size needs to take it: size / (1 + size). */
export const BLUFF_NEEDS: Record<BetSize, number> = { small: 0.4 / 1.4, half: 0.5 / 1.5, big: 0.7 / 1.7 };

/**
 * Rail's own study of bomb pots (ANALYSIS-PLAN §10, 2026-11-19, 2,606 WePlay
 * bomb pots): the percentile of hand strength on the board players showed
 * down after each line. Fixed numbers, shown as research.
 */
export const BOMB_AGGRESSION_STUDY: readonly {
  line: "flopRaise" | "turnRaise" | "turnBarrel" | "riverSmallBet";
  shown: [number, number];
}[] = [
  { line: "flopRaise", shown: [82, 82] },
  { line: "turnRaise", shown: [85, 85] },
  { line: "turnBarrel", shown: [83, 89] },
  { line: "riverSmallBet", shown: [70, 74] },
];

/** A first-bet size with fewer chances than this says "too few". */
export const MIN_CHANCES = 30;
