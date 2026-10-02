/**
 * What a pot that sees a flop is worth, without playing the flop.
 *
 * The preflop solver stops at the flop. A terminal where two to four players
 * see one is valued by an **equity-realisation model**: each player gets a
 * share of the pot (less rake) that starts from raw all-in equity and is then
 * bent by what happens postflop - position, initiative, and how well the hand
 * plays. The model is a `RealisationModel`: plain numbers, recorded in the
 * chart set, part of its hash.
 *
 * **The odds form.** Realisation is usually quoted as a factor `R` on equity:
 * a big blind that has 42% against a button open "realises 80%" of it. A
 * constant `R` cannot be right at the extremes and does not conserve the pot,
 * so the model works on odds instead:
 *
 *     share(i vs j) = e·w_i / (e·w_i + (1 - e)·w_j)
 *
 * with `e` the all-in equity of `i` against `j` and `w` each hand's
 * *realisation weight* in its role. Two equal weights leave the equity alone;
 * a ratio `w_i / w_j = g` multiplies the odds by `g`. The two players' shares
 * add up to exactly one, shares stay in [0, 1], and the effect is strongest for
 * marginal hands.
 *
 * **Weights by role and class.** A player's weight depends on the pot type, on
 * its role against the opponent - in or out of position, last preflop raiser
 * or caller - and on its hand class, through a log-linear function of a few
 * class features (`REALISATION_FEATURES`: pair and its rank, suitedness, the
 * gap between the ranks, the ranks themselves, suited and offsuit aces):
 *
 *     log w(i) = bias[potType][role] + Σ_f coef[potType][role][f] · φ_f(i)
 *
 * `charts/1` set these numbers by hand (`CHARTS1_REALISATION`: one
 * playability multiplier per feature for every role, and position and
 * initiative edges as the biases). `charts/2` **fits** them to the postflop
 * solver: `lib/charts/realisation.ts` solves sampled turn+river spots between
 * the charts' own ranges (`preflopRealisation.ts`) and fits the coefficients
 * to the shares the solver realised, per class. See docs/CHARTS.md §4.
 *
 * **Biases are edges.** Only the ratio of two players' weights matters, so the
 * biases are written as position and initiative edges `P`, `I` (log odds
 * multipliers): `ipAgg = (P + I)/2`, `oopCaller = -(P + I)/2`,
 * `ipCaller = (P - I)/2`, `oopAgg = -(P - I)/2`. A raiser in position against
 * a caller gets `P + I`; two callers get `P` between them.
 *
 * **Multiway.** In a pot with `n` players (up to four) each pair of players
 * gets its pairwise share `s` with its own roles, combined per deal as
 *
 *     share_p = x_p + (1 - Σ_k x_k) / n,    x_p = Π_{q ≠ p} s_pq
 *
 * `x_p` approximates "p beats everyone" and the remainder is split evenly.
 *
 * **Rake.** Taken only when a flop is dealt ("no flop, no drop"), as a
 * percentage of the *final* pot up to a cap; the final pot is estimated as
 * `flop pot x RAKE_POT_GROWTH[potType]`.
 */

import { NUM_COMBOS } from "./combos";
import { CLASS_COMBOS, COMBOS_AFTER_HAND, COMPAT, HAND_CLASSES, NUM_CLASSES } from "./handClasses";

/** How a pot that saw a flop was built. `allin`: no betting left. */
export type PotType = "limped" | "srp" | "3bet" | "4bet" | "allin";
export const POT_TYPES: readonly PotType[] = ["limped", "srp", "3bet", "4bet", "allin"];

/**
 * A player's role against one opponent in a pot that sees a flop: in or out
 * of position, and the last preflop raiser (`Agg`) or not (`Caller`; both
 * players in a limped pot, and two callers of someone else's raise).
 */
export type RealisationRole = "ipAgg" | "oopAgg" | "ipCaller" | "oopCaller";
export const REALISATION_ROLES: readonly RealisationRole[] = ["ipAgg", "oopAgg", "ipCaller", "oopCaller"];

/**
 * Class features of the realisation weight. Ranks run 0 (deuce) to 12 (ace);
 * every feature is 0 or 1 except the scaled ranks.
 *
 * - `pair`: a pocket pair; `pairLow`: `(12 - rank) / 12` for a pair (1 for 22,
 *   0 for AA) - set-mining versus overpair hands;
 * - `suited`;
 * - `gap0`, `gap1`, `gap2`: unpaired with 0, 1, 2 ranks between (76, 75, 74);
 * - `offGap3`: offsuit with three or more between (A8o, K9o, Q6o);
 * - `high`, `low`: the higher / lower rank / 12, for unpaired hands;
 * - `suitedAce`, `offAce`: unpaired with an ace, suited / offsuit.
 */
export const REALISATION_FEATURES = [
  "pair",
  "pairLow",
  "suited",
  "gap0",
  "gap1",
  "gap2",
  "offGap3",
  "high",
  "low",
  "suitedAce",
  "offAce",
] as const;
export type RealisationFeature = (typeof REALISATION_FEATURES)[number];

/** Feature values of every class, `[class * features + f]`. */
export const CLASS_FEATURES: Float64Array = (() => {
  const nf = REALISATION_FEATURES.length;
  const out = new Float64Array(NUM_CLASSES * nf);
  for (let i = 0; i < NUM_CLASSES; i += 1) {
    const c = HAND_CLASSES[i];
    const gap = c.hi - c.lo - 1;
    const v: Record<RealisationFeature, number> = {
      pair: c.pair ? 1 : 0,
      pairLow: c.pair ? (12 - c.hi) / 12 : 0,
      suited: c.suited ? 1 : 0,
      gap0: !c.pair && gap === 0 ? 1 : 0,
      gap1: !c.pair && gap === 1 ? 1 : 0,
      gap2: !c.pair && gap === 2 ? 1 : 0,
      offGap3: !c.pair && !c.suited && gap >= 3 ? 1 : 0,
      high: c.pair ? 0 : c.hi / 12,
      low: c.pair ? 0 : c.lo / 12,
      suitedAce: !c.pair && c.suited && c.hi === 12 ? 1 : 0,
      offAce: !c.pair && !c.suited && c.hi === 12 ? 1 : 0,
    };
    REALISATION_FEATURES.forEach((f, k) => {
      out[i * nf + k] = v[f];
    });
  }
  return out;
})();

/** One role's weight function: `log w = bias + Σ coef[f] φ_f`. */
export interface RoleRealisation {
  bias: number;
  coef: Readonly<Partial<Record<RealisationFeature, number>>>;
}

/** Every pot type's four role weight functions. `allin` is always neutral. */
export interface RealisationModel {
  /** Stable name, recorded in the chart set. */
  name: string;
  /** Where the numbers come from, one sentence. */
  source: string;
  potTypes: Readonly<Record<PotType, Readonly<Record<RealisationRole, RoleRealisation>>>>;
}

/** Biases from position and initiative edges given as odds multipliers. */
export function roleBiases(position: number, initiative: number): Record<RealisationRole, number> {
  const p = Math.log(position);
  const i = Math.log(initiative);
  return { ipAgg: (p + i) / 2, oopCaller: -(p + i) / 2, ipCaller: (p - i) / 2, oopAgg: -(p - i) / 2 };
}

function sameForRoles(
  biases: Record<RealisationRole, number>,
  coef: Partial<Record<RealisationFeature, number>>,
): Record<RealisationRole, RoleRealisation> {
  const out = {} as Record<RealisationRole, RoleRealisation>;
  for (const role of REALISATION_ROLES) out[role] = { bias: biases[role], coef: { ...coef } };
  return out;
}

/**
 * The `charts/1` model in this form, the generator's starting point: one
 * playability per class for every role (suited x1.15; connectors x1.06,
 * one-gappers x1.04, two-gappers x1.02; pairs x1.12; offsuit with a gap of
 * three or more x0.90), faded by pot type (exponent 1 / 1 / 0.6 / 0.3 / 0),
 * and position / initiative edges 1.25/1, 1.30/1.10, 1.20/1.08, 1.08/1.04
 * for limped, single-raised, 3-bet and 4-bet pots.
 */
export const CHARTS1_REALISATION: RealisationModel = (() => {
  const play = (exponent: number): Partial<Record<RealisationFeature, number>> => ({
    pair: exponent * Math.log(1.12),
    suited: exponent * Math.log(1.15),
    gap0: exponent * Math.log(1.06),
    gap1: exponent * Math.log(1.04),
    gap2: exponent * Math.log(1.02),
    offGap3: exponent * Math.log(0.9),
  });
  return {
    name: "charts/1-hand-set",
    source: "constants set by hand from published realisation bands (charts/1)",
    potTypes: {
      limped: sameForRoles(roleBiases(1.25, 1), play(1)),
      srp: sameForRoles(roleBiases(1.3, 1.1), play(1)),
      "3bet": sameForRoles(roleBiases(1.2, 1.08), play(0.6)),
      "4bet": sameForRoles(roleBiases(1.08, 1.04), play(0.3)),
      allin: sameForRoles(roleBiases(1, 1), {}),
    },
  };
})();

/** A role's realisation weight for every class. */
export function roleWeights(model: RealisationModel, potType: PotType, role: RealisationRole): Float64Array {
  const r = model.potTypes[potType][role];
  const nf = REALISATION_FEATURES.length;
  const coef = REALISATION_FEATURES.map((f) => r.coef[f] ?? 0);
  const out = new Float64Array(NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i += 1) {
    let x = r.bias;
    for (let k = 0; k < nf; k += 1) x += coef[k] * CLASS_FEATURES[i * nf + k];
    out[i] = Math.exp(x);
  }
  return out;
}

/** The role of a player against one opponent. */
export function realisationRole(inPosition: boolean, aggressor: boolean): RealisationRole {
  if (aggressor) return inPosition ? "ipAgg" : "oopAgg";
  return inPosition ? "ipCaller" : "oopCaller";
}

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

/** The model as recorded in a chart set: the form, every coefficient, the rake growth. */
export function realisationAssumptions(model: RealisationModel = CHARTS1_REALISATION) {
  return {
    form: "odds: share = e*w_i / (e*w_i + (1-e)*w_j); log w = bias[potType][role] + Σ coef·feature(class)",
    name: model.name,
    source: model.source,
    features: [...REALISATION_FEATURES],
    potTypes: model.potTypes,
    rakePotGrowth: { ...RAKE_POT_GROWTH },
    multiway: "share_p = x_p + (1 - Σx)/n, x_p = Π_q s_pq",
  };
}

/**
 * The realised-share matrix for a hero against one opponent, already weighted
 * by card removal: `S[i * 169 + j] = m[i][j] / 1225 * share(i vs j)`, so that
 * `S · reach` is the hero's expected share against that opponent's reach.
 * `hero` and `opp` are the two players' weight vectors (`roleWeights`).
 */
export function shareMatrix(
  equity: Float64Array,
  hero: ArrayLike<number>,
  opp: ArrayLike<number>,
  cardRemoval = true,
): Float64Array {
  const n = NUM_CLASSES;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const wi = hero[i];
    for (let j = 0; j < n; j += 1) {
      const k = i * n + j;
      const e = equity[k];
      const a = e * wi;
      const b = (1 - e) * opp[j];
      const share = a + b > 0 ? a / (a + b) : 0.5;
      const weight = cardRemoval ? COMPAT[k] / COMBOS_AFTER_HAND : CLASS_COMBOS[j] / NUM_COMBOS;
      out[k] = weight * share;
    }
  }
  return out;
}
