/**
 * One hand's part of the Pool tab (docs/ANALYTICS.md Step 10): each named
 * opponent's catalogue rates and result, as `analytics_pool_save` takes them
 * (`20271122100000_analytics_pool.sql`). Pure.
 *
 * The same counts as the desktop's: its custom pass counts the catalogue's
 * rates (`an_<id>`, `Catalogue::custom_defs`) on every kept seat into
 * `custom_player_rollups`, and `rail_store::pool` sums each opponent's
 * result. Here:
 *
 * - only hands with a hero, at a room that prints real names
 *   (`detectAnonymization` = `none`: a positional or opaque name is not a
 *   person), and not a bomb pot (`aggregate`'s default) - any other hand
 *   counts, with no players;
 * - every other seat with a name: its counts of every rate it had an
 *   opportunity at (`ANALYTICS.counts` over `handEvents`), and its result in
 *   big blinds - `null` in a hand whose money does not count (an EV
 *   cashout), as the desktop leaves those out of the results.
 */
import type { PhfHand } from "../phf/types";
import { ANALYTICS, type Catalogue } from "../stats/analytics";
import { handFacts } from "../stats/derive";
import { handEvents } from "../stats/events";
import { statsRows } from "../stats/mapping";
import { detectAnonymization } from "./anonymization";

/** One opponent's part of a hand. */
export interface PoolSeat {
  player: string;
  /** Big blinds, 3 decimals; null when the hand's money does not count. */
  net_bb: number | null;
  /** Catalogue rate id -> [made, opportunities], only rates with an opportunity. */
  stats: Record<string, [number, number]>;
}

/** A hand as `analytics_pool_save` takes it. */
export interface PoolHand {
  hand_id: string;
  players: PoolSeat[];
}

/** The named opponents' counts of one hand (empty when it does not count; see the module docs). */
export function poolSeats(hand: PhfHand, catalogue: Catalogue = ANALYTICS): PoolSeat[] {
  if (detectAnonymization(hand) !== "none") return [];
  const rows = statsRows(handFacts(hand));
  if (!rows.some((row) => row.is_hero)) return [];
  if (rows.some((row) => row.is_bomb_pot)) return [];
  const events = handEvents(hand);
  const out: PoolSeat[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.is_hero || row.player === "" || seen.has(row.player)) continue;
    seen.add(row.player);
    const seat = events.seats.find((s) => s.seat === row.seat);
    const stats: Record<string, [number, number]> = {};
    if (seat) {
      const counts = catalogue.counts(events, seat);
      catalogue.stats.forEach((stat, index) => {
        const c = counts[index];
        if (stat.kind === "rate" && c && c.opp > 0) stats[stat.id] = [c.made, c.opp];
      });
    }
    out.push({
      player: row.player.slice(0, 100),
      net_bb: row.has_cashout ? null : Math.round(row.net_bb_milli) / 1000,
      stats,
    });
  }
  return out;
}

/** A hand in the writer's shape. */
export function poolHand(handId: string, hand: PhfHand | null): PoolHand {
  return { hand_id: handId, players: hand ? poolSeats(hand) : [] };
}
