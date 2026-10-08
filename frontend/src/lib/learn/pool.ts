/**
 * The learner's own player pool, for the exploit lessons (Learn L4, the
 * opponents-panel tie-in).
 *
 * The opponents panel (`stats_opponents`, an invoker function under RLS) has
 * one row per opponent the learner kept statistics on. Summed, those rows are
 * the learner's own pool: how often the people they actually play fold to a
 * flop c-bet, show down, bet and raise — each with the number of chances it
 * was counted over and the 95% interval that sample allows
 * (`marginOfError`). Nothing here is a population figure from anywhere else;
 * a stat with too few chances behind it says so instead of reading anything
 * into it.
 *
 * **Reads.** The only tendency this turns into a suggestion is one plain
 * arithmetic can judge: folds to a flop c-bet against the folds a pure bluff
 * of a given size needs (`alpha`). A pool whose whole interval sits above what
 * a half-pot bluff needs folds more than that bluff needs; one whose whole
 * interval sits below what a third-pot bluff needs folds less. Everything
 * else is shown with its sample, for the learner to judge, and no lesson
 * claims what "the pool" does without it.
 *
 * Pure: the screen fetches the rows.
 */

import type { LabPreset } from "../training/labPresets";
import type { LessonId, PoolTopic } from "./course";
import { alpha, marginOfError, sampleNeeded } from "./math";

export const POOL_STATS = ["vpip", "pfr", "threeBet", "foldToThreeBet", "cbet", "foldToCbet", "wtsd", "wsd", "aggression"] as const;
export type PoolStatId = (typeof POOL_STATS)[number];

/** Fewer chances than this and a stat is not shown as a number worth reading. */
export const MIN_CHANCES = 30;
/** A 95% interval wider than ± this is "not enough data"; up to it, "rough". */
export const THIN_MARGIN = 0.1;
/** A 95% interval within ± this is "settled". */
export const SETTLED_MARGIN = 0.05;

/** Which stats each lesson shows, most relevant first. */
export const POOL_TOPIC_STATS: Readonly<Record<PoolTopic, readonly PoolStatId[]>> = {
  all: POOL_STATS,
  overfold: ["foldToCbet", "foldToThreeBet", "wtsd"],
  station: ["foldToCbet", "wtsd", "vpip"],
  aggro: ["aggression", "cbet", "threeBet"],
  underbluff: ["wtsd", "wsd", "aggression"],
};

/** A row of the opponents panel, as far as the pool needs it: counters by the database's names. */
export interface PoolRow {
  counters: Readonly<Record<string, number>>;
}

export type PoolLevel = "thin" | "rough" | "settled";

export interface PoolStat {
  id: PoolStatId;
  /** Times it happened, and the chances it had. */
  made: number;
  chances: number;
  /** `made / chances`; null without a chance. */
  value: number | null;
  /** Half-width of the 95% interval; null without a chance. */
  margin: number | null;
  level: PoolLevel;
  /** Chances a stat at this value needs for ± `SETTLED_MARGIN`; null without a value. */
  neededForSettled: number | null;
}

export interface Pool {
  /** Opponents summed. */
  players: number;
  /** Hands summed over them (one hand counts once per opponent in it). */
  hands: number;
  stats: Readonly<Record<PoolStatId, PoolStat>>;
}

/** A stat's counters in the opponents report: [made, chances]. */
const KEYS: Readonly<Record<Exclude<PoolStatId, "aggression">, readonly [string, string]>> = {
  vpip: ["vpip", "vpip_opp"],
  pfr: ["pfr", "pfr_opp"],
  threeBet: ["three_bet", "three_bet_opp"],
  foldToThreeBet: ["fold_to_three_bet", "fold_to_three_bet_opp"],
  cbet: ["cbet_flop", "cbet_flop_opp"],
  foldToCbet: ["fold_to_cbet_flop", "fold_to_cbet_flop_opp"],
  wtsd: ["wtsd", "wtsd_opp"],
  wsd: ["wsd", "wsd_opp"],
};

const STREETS = ["flop", "turn", "river"] as const;

/** One stat from its counts. */
export function poolStat(id: PoolStatId, made: number, chances: number): PoolStat {
  if (!(chances > 0)) return { id, made: 0, chances: 0, value: null, margin: null, level: "thin", neededForSettled: null };
  const value = Math.min(1, Math.max(0, made / chances));
  const margin = marginOfError(value, chances);
  const level: PoolLevel = chances < MIN_CHANCES || margin > THIN_MARGIN ? "thin" : margin > SETTLED_MARGIN ? "rough" : "settled";
  return { id, made, chances, value, margin, level, neededForSettled: Math.ceil(sampleNeeded(value, SETTLED_MARGIN)) };
}

/**
 * The opponents' rows summed into one pool. Aggression is the share of
 * postflop decisions that bet or raise (the panel's aggression frequency):
 * a frequency, so it has an interval like the others.
 */
export function poolOf(rows: readonly PoolRow[]): Pool {
  const total = (key: string) => rows.reduce((sum, row) => sum + (Number(row.counters[key]) || 0), 0);
  const stats = {} as Record<PoolStatId, PoolStat>;
  for (const id of POOL_STATS) {
    if (id === "aggression") {
      let aggressive = 0;
      let decisions = 0;
      for (const street of STREETS) {
        const bets = total(`bet_${street}`) + total(`raise_${street}`);
        aggressive += bets;
        decisions += bets + total(`call_${street}`) + total(`fold_${street}`);
      }
      stats[id] = poolStat(id, aggressive, decisions);
      continue;
    }
    const [made, chances] = KEYS[id];
    stats[id] = poolStat(id, total(made), total(chances));
  }
  return { players: rows.length, hands: total("hands"), stats };
}

/** A tendency the pool's own numbers support, and where to practise against it. */
export interface PoolRead {
  stat: PoolStatId;
  /** The bluff size (fraction of the pot) whose break-even the interval clears. */
  size: number;
  /** Folds that size needs (`alpha`). */
  needs: number;
  direction: "above" | "below";
  lesson: LessonId;
  preset: LabPreset;
}

/** The c-bet sizes a read is judged against: a half-pot bluff (folds above), a third-pot bluff (folds below). */
export const READ_SIZES = { above: 0.5, below: 1 / 3 } as const;

/**
 * What the pool's numbers support, as reads with a lesson and a lab preset.
 * Only from a stat that is not "thin", and only when its whole interval clears
 * the line.
 */
export function poolReads(pool: Pool): PoolRead[] {
  const out: PoolRead[] = [];
  const fold = pool.stats.foldToCbet;
  if (fold.level !== "thin" && fold.value !== null && fold.margin !== null) {
    const above = alpha(1, READ_SIZES.above);
    const below = alpha(1, READ_SIZES.below);
    if (fold.value - fold.margin > above) {
      out.push({ stat: "foldToCbet", size: READ_SIZES.above, needs: above, direction: "above", lesson: "exploiting-overfolders", preset: "overfold" });
    } else if (fold.value + fold.margin < below) {
      out.push({ stat: "foldToCbet", size: READ_SIZES.below, needs: below, direction: "below", lesson: "exploiting-calling-stations", preset: "station" });
    }
  }
  return out;
}
