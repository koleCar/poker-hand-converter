/**
 * What a pot that sees a flop is worth, without playing the flop.
 *
 * The preflop solver stops at the flop. A terminal where two to four players
 * see one is valued by an **equity-realisation model**: each player gets a
 * share of the pot (less rake) that starts from raw all-in equity and is then
 * bent by what happens postflop - position, initiative, and how playable the
 * hand is. Every number that does the bending is a named constant below, is
 * part of the chart set's recorded assumptions, and changes the chart version
 * when it changes.
 *
 * **The odds form.** Realisation is usually quoted as a factor `R` on equity:
 * a big blind that has 42% against a button open "realises 80%" of it. A
 * constant `R` cannot be right at the extremes (AA at 85% does not realise
 * 68% out of position), and a pair of factors per spot does not conserve the
 * pot (both players' shares need not add up to one). So the model works on
 * odds instead:
 *
 *     share(i vs j) = e·w_i / (e·w_i + (1 - e)·w_j)
 *
 * with `e` the all-in equity of `i` against `j` and `w` each hand's
 * *realisation weight*. Two equal weights leave the equity alone; a ratio
 * `w_i / w_j = g` multiplies the odds by `g`. The two players' shares always add
 * up to exactly one, shares stay in [0, 1], and the effect is strongest for
 * marginal hands and fades at the extremes - which is the shape published
 * realisation estimates have (strong hands realise ~100% or more, weak hands
 * much less). The weight is
 *
 *     w = playability(hand) ^ PLAYABILITY_EXPONENT[potType]
 *         · sqrt(POSITION_EDGE[potType])^(±1)        (IP +, OOP -)
 *         · sqrt(INITIATIVE_EDGE[potType])^(±1)      (last raiser +, caller -)
 *
 * **Calibration and sources.** The numbers are ours, chosen to land the
 * implied range-average realisation where public poker literature puts it -
 * roughly 0.75-0.85 for a big blind defending against a late-position open
 * and 1.05-1.15 for the in-position raiser in a single-raised pot (Acevedo,
 * *Modern Poker Theory*, 2019, ch. 2-3; the widely quoted solver-derived
 * figures in training material agree on those bands). With the constants
 * below a BB range with 42% raw equity against a button range realises
 * 0.336 of the pot (R ~0.80) and the button 0.664 (R ~1.14). No chart or
 * solution from any product is used, as input or as a target.
 *
 * - `POSITION_EDGE` shrinks with the pot type because the stack-to-pot ratio
 *   does: ~18 in a single-raised pot, ~4.5 in a 3-bet pot, ~1.5 in a 4-bet pot,
 *   and 0 all-in. Less play left, less for position to win.
 * - `INITIATIVE_EDGE` gives the last preflop raiser a smaller edge: the range
 *   advantage of the aggressor shows up as fold equity on the flop.
 * - `PLAYABILITY`: suited hands make flushes and flush draws, connected hands
 *   straights and straight draws, pocket pairs sets; all turn equity into
 *   realised equity better than raw equity says (they win big pots and fold
 *   cheaply). Offsuit unconnected hands do the opposite: their top pairs are
 *   dominated and they have nothing to draw to. The exponent fades
 *   playability with the SPR the same way.
 *
 * **Multiway.** In a pot with `n` players (up to four) each pair of players
 * gets its pairwise realised share `s` with its own position and initiative
 * relation, and the shares are combined per deal as
 *
 *     share_p = x_p + (1 - Σ_k x_k) / n,    x_p = Π_{q ≠ p} s_pq
 *
 * `x_p` approximates "p beats everyone" (in a random tournament at most one
 * player beats all others, so Σ x ≤ 1) and the remainder is split evenly. It
 * sums to one per deal and gives 1/n each for equal hands; AA against two
 * random hands gets ~0.77 (true all-in equity 0.73). Number of players enters
 * the model only through this combination: a hand that realises poorly
 * against each opponent realises worse against several.
 *
 * **Rake.** Cash-game rake is taken only when a flop is dealt ("no flop, no
 * drop"), as a percentage of the *final* pot up to a cap. The preflop solver
 * knows only the pot at the flop, so the final pot is estimated as
 * `flop pot x RAKE_POT_GROWTH[potType]`: our estimate of the average growth
 * from flop to end of hand, larger in small pots (more streets of betting
 * relative to the pot) and 1 all-in. It decides how often the cap binds,
 * which is what matters for 3-bet and 4-bet pots.
 */

import { NUM_COMBOS } from "./combos";
import { CLASS_COMBOS, COMBOS_AFTER_HAND, COMPAT, HAND_CLASSES, NUM_CLASSES } from "./handClasses";

/** How a pot that saw a flop was built. `allin`: no betting left. */
export type PotType = "limped" | "srp" | "3bet" | "4bet" | "allin";
export const POT_TYPES: readonly PotType[] = ["limped", "srp", "3bet", "4bet", "allin"];

/** Odds multiplier of the in-position player over the out-of-position one. */
export const POSITION_EDGE: Readonly<Record<PotType, number>> = {
  limped: 1.25,
  srp: 1.3,
  "3bet": 1.2,
  "4bet": 1.08,
  allin: 1,
};

/** Odds multiplier of the last preflop raiser over a caller. */
export const INITIATIVE_EDGE: Readonly<Record<PotType, number>> = {
  limped: 1,
  srp: 1.1,
  "3bet": 1.08,
  "4bet": 1.04,
  allin: 1,
};

/** Playability multipliers on a hand's realisation weight. */
export const PLAYABILITY = {
  suited: 1.15,
  /** By gap between the ranks: 0 = connector (76), 1 = one-gapper (75), 2 = two-gapper. */
  connected: [1.06, 1.04, 1.02] as readonly number[],
  /** Pocket pairs: sets win stacks that raw equity does not count (implied odds). */
  pair: 1.12,
  /**
   * Offsuit hands with a gap of three or more (A8o, K9o, Q6o): no straight
   * draws, no flush draws, and a top pair that is often dominated - the
   * hands that lose the most realised equity against a range.
   */
  offsuitUnconnected: 0.9,
} as const;

/** How much playability counts, by pot type (fades with the SPR). */
export const PLAYABILITY_EXPONENT: Readonly<Record<PotType, number>> = {
  limped: 1,
  srp: 1,
  "3bet": 0.6,
  "4bet": 0.3,
  allin: 0,
};

/** Rake as the rooms take it: a percentage of the pot up to a cap, no flop no drop. */
export interface RakeProfile {
  /** `"5%-cap3bb-nfnd"`: a stable name, part of the chart's assumptions. */
  name: string;
  percent: number;
  capBb: number;
  noFlopNoDrop: boolean;
}

/** The standard profile the charts are solved with: 5%, capped at 3bb, no flop no drop. */
export const STANDARD_RAKE: Readonly<RakeProfile> = {
  name: "5%-cap3bb-nfnd",
  percent: 0.05,
  capBb: 3,
  noFlopNoDrop: true,
};

export const NO_RAKE: Readonly<RakeProfile> = { name: "none", percent: 0, capBb: 0, noFlopNoDrop: true };

/** Estimated final pot / pot at the flop, for the rake (see header). */
export const RAKE_POT_GROWTH: Readonly<Record<PotType, number>> = {
  limped: 2,
  srp: 1.75,
  "3bet": 1.4,
  "4bet": 1.15,
  allin: 1,
};

/** Rake taken from a pot of `potBb` that saw a flop as `potType`. */
export function flopRake(potBb: number, potType: PotType, rake: Readonly<RakeProfile>): number {
  if (rake.percent <= 0) {
    return 0;
  }
  const final = potBb * RAKE_POT_GROWTH[potType];
  return Math.min(final * rake.percent, rake.capBb, potBb);
}

/** Playability multiplier of a class (before the pot-type exponent). */
export function playability(index: number): number {
  const c = HAND_CLASSES[index];
  if (c.pair) {
    return PLAYABILITY.pair;
  }
  const gap = c.hi - c.lo - 1;
  if (!c.suited && gap >= PLAYABILITY.connected.length) {
    return PLAYABILITY.offsuitUnconnected;
  }
  let w = c.suited ? PLAYABILITY.suited : 1;
  if (gap < PLAYABILITY.connected.length) {
    w *= PLAYABILITY.connected[gap];
  }
  return w;
}

/** All the model's constants, as recorded in a chart set. */
export function realisationAssumptions() {
  return {
    form: "odds: share = e*w_i / (e*w_i + (1-e)*w_j)",
    positionEdge: { ...POSITION_EDGE },
    initiativeEdge: { ...INITIATIVE_EDGE },
    playability: {
      suited: PLAYABILITY.suited,
      connected: [...PLAYABILITY.connected],
      pair: PLAYABILITY.pair,
      offsuitUnconnected: PLAYABILITY.offsuitUnconnected,
    },
    playabilityExponent: { ...PLAYABILITY_EXPONENT },
    rakePotGrowth: { ...RAKE_POT_GROWTH },
    multiway: "share_p = x_p + (1 - Σx)/n, x_p = Π_q s_pq",
  };
}

/**
 * The realised-share matrix for a hero against one opponent, already weighted
 * by card removal: `S[i * 169 + j] = m[i][j] / 1225 * share(i vs j)`, so that
 * `S · reach` is the hero's expected share against that opponent's reach.
 *
 * `ratio` is `w_hero / w_opp` without playability (position and initiative).
 */
export function shareMatrix(
  equity: Float64Array,
  potType: PotType,
  ratio: number,
  cardRemoval = true,
): Float64Array {
  const n = NUM_CLASSES;
  const exponent = PLAYABILITY_EXPONENT[potType];
  const play = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    play[i] = Math.pow(playability(i), exponent);
  }
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const wi = play[i] * ratio;
    for (let j = 0; j < n; j += 1) {
      const k = i * n + j;
      const e = equity[k];
      const a = e * wi;
      const b = (1 - e) * play[j];
      const share = a + b > 0 ? a / (a + b) : 0.5;
      const weight = cardRemoval ? COMPAT[k] / COMBOS_AFTER_HAND : CLASS_COMBOS[j] / NUM_COMBOS;
      out[k] = weight * share;
    }
  }
  return out;
}

/**
 * Hero's position/initiative weight ratio against one opponent.
 *
 * `heroIp`: the hero acts after the opponent postflop. `aggressor`: the player
 * index of the last preflop raiser (or -1), compared with `hero` / `opp`.
 */
export function weightRatio(
  potType: PotType,
  heroIp: boolean,
  heroIsAggressor: boolean,
  oppIsAggressor: boolean,
): number {
  const pos = POSITION_EDGE[potType];
  const init = INITIATIVE_EDGE[potType];
  let ratio = heroIp ? pos : 1 / pos;
  if (heroIsAggressor) ratio *= init;
  if (oppIsAggressor) ratio /= init;
  return ratio;
}
