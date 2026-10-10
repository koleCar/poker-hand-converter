/**
 * Per-villain preflop ranges: a population range moved by the opponent's own
 * statistics in the learner's library (analysis/20, `docs/ANALYSIS-PLAN.md`
 * §10 2026-10-10, villain statistics).
 *
 * `population.ts` gives every opponent who flat-called a raise or limped one
 * range per line, fitted on the hands such players show down. A player who
 * puts money in passively far more (or less) often than the pool should play
 * a wider (or narrower) range there. The learner's opponents panel already
 * counts it - VPIP, PFR and the hands they were counted over - so the
 * analysis can be handed those counters and shift the line's logit:
 *
 *     passive  = (VPIP − PFR) / hands          (hands = `vpip_opp`)
 *     shrunk   = (VPIP − PFR + k · pool) / (hands + k)
 *     δ        = γ · (logit(shrunk) − logit(pool) − c)
 *     weight'  = σ(logit(weight) + δ)
 *
 * shrunk to the pool's rate by the sample (k hands of prior weight) and not
 * applied at all below `VILLAIN_MIN_HANDS`. γ and c were fitted on the
 * owner's opponents' shown hands, the pool rate is theirs too: four numbers,
 * nothing per player stored.
 *
 * **Only the big blind's defence.** Held out (five folds by player, every
 * shown hand scored with its player's statistics counted without that hand,
 * and again with only the hands played before it), the shift explains shown
 * big-blind defences better than the population range by about 0.065 per
 * combo, more than three standard errors; on cold calls, limps and
 * limp-calls no statistic tried (VPIP − PFR, VPIP, the cold-call or limp
 * frequency) did better than the population range, and on limps it did
 * worse. So the other lines keep the population range (§10).
 *
 * Exploit numbers only from the learner's own villain statistics, with their
 * sample (the owner's rule): every range moved here carries the sample it was
 * moved on (`VillainSample`), and the decision shows it
 * (`SpotFacts.villain`).
 *
 * Pure and deterministic: the caller hands the counters in
 * (`AnalyzeOptions.villains`); nothing here reads a database.
 */

import type { ClassWeights } from "../equity/range";
import { populationRange, type PopulationLine } from "./population";

/** The rule's name, quoted by the docs and the tests. */
export const VILLAIN_RANGES = "villain/1" as const;

/**
 * One opponent's statistics counters in the learner's library, as the
 * opponents panel sums them (`stats_opponents`): hands with a voluntary
 * preflop decision (`vpip_opp`, the sample), and in how many of those they
 * put money in (`vpip`) and raised (`pfr`).
 */
export interface VillainStats {
  vpipOpp: number;
  vpip: number;
  pfr: number;
}

/** Opponents' statistics by `villainKey(site, player)`. */
export type VillainStatsMap = Readonly<Record<string, VillainStats>>;

/** The key an opponent's statistics are looked up by: the room's id and the player's name, as stored. */
export function villainKey(site: string, player: string): string {
  return `${site}:${player}`;
}

/** Fewer hands than this behind a player's statistics and nothing moves. */
export const VILLAIN_MIN_HANDS = 30;
/** The pool's weight in hands: a player's rate is shrunk toward the pool's by `n / (n + k)`. */
export const VILLAIN_PRIOR_HANDS = 15;
/** The pool's (VPIP − PFR) / hands: every opponent in the owner's library. */
export const VILLAIN_POOL_PASSIVE = 0.1741;
/** γ: how far the line's logit moves per unit of the shrunk rate's logit (`villain/1`). */
const GAMMA = 1.318;
/** c: the shrunk rate's logit at which nothing moves, against the pool's (`villain/1`). */
const OFFSET = -0.207;

/** The population lines a player's statistics move: the big blind's defence only (held out, the only one that gained). */
export const VILLAIN_LINES: readonly PopulationLine[] = ["bb-defence"];

/** What a range was moved on: the player's sample and rates, and the shift. */
export interface VillainSample {
  /** Hands behind the statistics (`vpip_opp`). */
  hands: number;
  /** (VPIP − PFR) / hands, unshrunk. */
  passive: number;
  /** The rate shrunk toward the pool's. */
  shrunk: number;
  /** δ, added to every class's logit. */
  shift: number;
  /** The counters it was computed from, as handed in (integers). */
  stats: VillainStats;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const logit = (p: number) => Math.log(p / (1 - p));
const clampP = (p: number) => Math.min(0.995, Math.max(0.005, p));

/**
 * The sample a line's range is moved on, or null: the line is not one the
 * statistics move, no statistics, or fewer than `VILLAIN_MIN_HANDS` hands.
 */
export function villainSample(line: PopulationLine, stats: VillainStats | null | undefined): VillainSample | null {
  if (!stats || !VILLAIN_LINES.includes(line)) return null;
  const hands = Math.floor(Number(stats.vpipOpp));
  const vpip = Math.floor(Number(stats.vpip));
  const pfr = Math.floor(Number(stats.pfr));
  if (!Number.isFinite(hands) || !Number.isFinite(vpip) || !Number.isFinite(pfr)) return null;
  if (hands < VILLAIN_MIN_HANDS || vpip < 0 || pfr < 0) return null;
  const made = Math.min(hands, Math.max(0, vpip - pfr));
  const shrunk = (made + VILLAIN_PRIOR_HANDS * VILLAIN_POOL_PASSIVE) / (hands + VILLAIN_PRIOR_HANDS);
  const shift = GAMMA * (logit(clampP(shrunk)) - logit(VILLAIN_POOL_PASSIVE) - OFFSET);
  return { hands, passive: round4(made / hands), shrunk: round4(shrunk), shift: round4(shift), stats: { vpipOpp: hands, vpip, pfr } };
}

/** A line's population range moved by a sample (weights in 0..1). */
export function villainRange(line: PopulationLine, sample: VillainSample): ClassWeights {
  const out = new Map<string, number>();
  for (const [name, weight] of populationRange(line)) {
    const w = Math.min(1 - 1e-9, Math.max(1e-9, weight));
    out.set(name, round4(1 / (1 + Math.exp(-(logit(w) + sample.shift)))));
  }
  return out;
}
