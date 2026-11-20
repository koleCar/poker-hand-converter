/**
 * Bomb pots on their own (analysis/45): what the Analysis screen's Bomb pots
 * tab shows, summed from the hands themselves. Rail has never solved a bomb
 * pot, so nothing here is a grade: the hero's results, by ante and by their
 * first move on the flop, the hero's habits against the pool's (every other
 * player in the same hands), and how often the first bet on the flop takes
 * the pot down at each size.
 *
 * Pure: the tests run it, the app feeds it the stored bomb pots' PHF.
 */

import type { PhfAction, PhfHand } from "../phf/types";

type Street = "flop" | "turn" | "river";
const STREETS: readonly Street[] = ["flop", "turn", "river"];
const DECISIONS = new Set(["check", "bet", "call", "raise", "fold"]);

/** A count of chances and of the times it happened. */
export interface Rate {
  n: number;
  hits: number;
}

export interface ResultRow {
  hands: number;
  /** The hero's result, big blinds. */
  netBb: number;
}

export type FirstMove = "bet" | "check" | "call" | "raise" | "fold";
export type BetSize = "small" | "half" | "big";

export interface BombSummary {
  hands: number;
  netBb: number;
  showdownBb: number;
  nonShowdownBb: number;
  /** By the ante in big blinds (rounded), smallest first. */
  byAnte: (ResultRow & { anteBb: number })[];
  /** By the hero's first decision on the flop. */
  byFirstMove: (ResultRow & { move: FirstMove })[];
  /** The hero's and the pool's habits. */
  habits: Record<"betFlop" | "foldFlop" | "betTurn" | "betRiver", { hero: Rate; pool: Rate }>;
  /**
   * The first bet on the flop with six or more players in: how often every
   * other player folded, by size (under 40% of the pot, 40-70%, 70% and more).
   */
  foldThrough: Record<BetSize, Rate>;
}

/**
 * A decision's pot kind from its scenario (analysis/45): `bomb` (a `bomb-`
 * role), `mw` (three or more players at the decision, `-mw-`) or `hu`. The
 * Analysis tabs other than Multiway and Bomb pots read `hu` only.
 */
export type PotKindOf = "hu" | "mw" | "bomb";
export function potKindOfScenario(scenario: string): PotKindOf {
  if (scenario.startsWith("bomb-")) return "bomb";
  return scenario.includes("-mw-") ? "mw" : "hu";
}

/** Players in at the first flop bet for the fold-through count. */
export const FOLD_THROUGH_PLAYERS = 6;

const rate = (): Rate => ({ n: 0, hits: 0 });
const sizeOf = (sizePot: number): BetSize => (sizePot < 0.4 ? "small" : sizePot < 0.7 ? "half" : "big");

/** The hero's first-move key of a decision on the flop. */
function moveOf(type: string): FirstMove | null {
  return type === "bet" || type === "check" || type === "call" || type === "raise" || type === "fold" ? type : null;
}

export function bombSummary(hands: readonly PhfHand[]): BombSummary {
  const out: BombSummary = {
    hands: 0,
    netBb: 0,
    showdownBb: 0,
    nonShowdownBb: 0,
    byAnte: [],
    byFirstMove: [],
    habits: {
      betFlop: { hero: rate(), pool: rate() },
      foldFlop: { hero: rate(), pool: rate() },
      betTurn: { hero: rate(), pool: rate() },
      betRiver: { hero: rate(), pool: rate() },
    },
    foldThrough: { small: rate(), half: rate(), big: rate() },
  };
  const ante = new Map<number, ResultRow>();
  const first = new Map<FirstMove, ResultRow>();

  for (const hand of hands) {
    const hero = hand.players.find((p) => p.isHero);
    const bb = hand.game.bigBlind;
    if (!hero || !(bb > 0)) continue;
    const net = (hand.results.heroNet ?? 0) / bb;
    const heroResult = hand.results.players.find((p) => p.seat === hero.seat);
    out.hands += 1;
    out.netBb += net;
    if (heroResult?.wentToShowdown) out.showdownBb += net;
    else out.nonShowdownBb += net;

    const anteBb = Math.round((hand.game.bombPot?.ante ?? hand.game.ante) / bb);
    const byAnte = ante.get(anteBb) ?? { hands: 0, netBb: 0 };
    byAnte.hands += 1;
    byAnte.netBb += net;
    ante.set(anteBb, byAnte);

    walk(hand, hero.seat, net, out, first);
  }

  out.byAnte = [...ante.entries()].sort((a, b) => a[0] - b[0]).map(([anteBb, row]) => ({ anteBb, ...row }));
  const ORDER: FirstMove[] = ["bet", "call", "raise", "check", "fold"];
  out.byFirstMove = ORDER.filter((m) => first.has(m)).map((move) => ({ move, ...(first.get(move) as ResultRow) }));
  return out;
}

/** One hand's postflop actions: the habits, the hero's first flop move, the first flop bet's fold-through. */
function walk(hand: PhfHand, hero: number, net: number, out: BombSummary, first: Map<FirstMove, ResultRow>): void {
  const acts = hand.actions.filter((a) => a.seat !== null && (STREETS as readonly string[]).includes(a.street) && DECISIONS.has(a.type));
  const folded = new Set<number>();
  const dealt = hand.players.filter((p) => !p.sittingOut).length;
  let pot = hand.actions.filter((a) => a.street === "preflop").reduce((sum, a) => sum + (a.amount ?? 0), 0);
  let street: Street | null = null;
  let put = new Map<number, number>();
  let bets = 0;
  let heroFirst = false;

  for (let i = 0; i < acts.length; i += 1) {
    const a = acts[i] as PhfAction & { seat: number };
    const s = a.street as Street;
    if (s !== street) {
      street = s;
      put = new Map();
      bets = 0;
    }
    const isHero = a.seat === hero;
    const who = isHero ? "hero" : "pool";
    const mine = put.get(a.seat) ?? 0;
    const high = Math.max(0, ...put.values());

    if (bets === 0) {
      const key = s === "flop" ? "betFlop" : s === "turn" ? "betTurn" : "betRiver";
      out.habits[key][who].n += 1;
      if (a.type === "bet") out.habits[key][who].hits += 1;
    } else if (bets === 1 && s === "flop") {
      out.habits.foldFlop[who].n += 1;
      if (a.type === "fold") out.habits.foldFlop[who].hits += 1;
    }

    if (isHero && s === "flop" && !heroFirst) {
      heroFirst = true;
      const move = moveOf(a.type);
      if (move) {
        const row = first.get(move) ?? { hands: 0, netBb: 0 };
        row.hands += 1;
        row.netBb += net;
        first.set(move, row);
      }
    }

    let add = 0;
    if (a.type === "bet" || a.type === "raise") add = (a.streetTotal ?? mine + a.amount) - mine;
    else if (a.type === "call") add = a.amount;

    if (a.type === "bet" && s === "flop" && bets === 0) {
      const live = dealt - folded.size;
      if (live >= FOLD_THROUGH_PLAYERS && pot > 0) {
        const rest = acts.slice(i + 1).filter((b) => b.street === "flop");
        const bucket = out.foldThrough[sizeOf(add / pot)];
        bucket.n += 1;
        if (rest.length > 0 && rest.every((b) => b.type === "fold")) bucket.hits += 1;
      }
    }

    if (a.type === "fold") folded.add(a.seat);
    if (a.type === "bet" || a.type === "raise") {
      bets += 1;
      put.set(a.seat, mine + add);
      pot += add;
    } else if (a.type === "call") {
      put.set(a.seat, Math.min(high, mine + a.amount));
      pot += a.amount;
    }
  }
}
