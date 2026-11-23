/**
 * A checker spot's name (docs/ANALYTICS.md Step 2): the one function both
 * apps name a spot with. The key is `pot|role|hero|opponent`, built where
 * the rows are derived (`web/src/lib/stats/analyticsRows.ts` `spotKey`, its
 * Rust twin `rail_stats::analytics_rows::spot_key`):
 *
 * - preflop: no pot; the role is the preflop scenario (`unopened`,
 *   `vs-open`, `vs-3bet`, ...); the opponent is the last raiser, '' with none;
 * - after the flop: the pot (`limped`, `single-raised`, `3bet`, `4bet+`,
 *   `bomb`) and the hero's role (`pfr`, `caller`, `limped`, `bomb`); the
 *   opponent is the street's last bettor or raiser, else the one opponent
 *   left, `multi` with two or more.
 *
 * "BB vs SB", then the pot and the role in words: "BB vs SB · 3-bet pot ·
 * as the caller". The words are `strings/analytics.{en,hr}.ts`' `spot`.
 */

import type { AnalyticsStrings } from "../i18n";

export interface Spot {
  pot: string;
  role: string;
  hero: string;
  opponent: string;
}

/** The four parts of a key; missing parts are ''. */
export function parseSpot(key: string): Spot {
  const [pot = "", role = "", hero = "", opponent = ""] = key.split("|");
  return { pot, role, hero, opponent };
}

/** The key of a spot (the inverse of {@link parseSpot}). */
export function spotKeyOf(spot: Spot): string {
  return `${spot.pot}|${spot.role}|${spot.hero}|${spot.opponent}`;
}

/** The seats: "BB vs SB", "BTN vs 2+", or the hero alone. */
export function spotSeats(spot: Spot, words: AnalyticsStrings["spot"]): string {
  if (spot.hero === "") return words.anySeat;
  if (spot.opponent === "") return spot.hero;
  return words.versus(spot.hero, spot.opponent === "multi" ? words.multi : spot.opponent);
}

/** The spot in words: the seats, then the pot and the role where they say something. */
export function spotName(key: string, words: AnalyticsStrings["spot"]): string {
  const spot = parseSpot(key);
  const parts = [spotSeats(spot, words)];
  const pot = words.pots[spot.pot];
  if (pot) parts.push(pot);
  const role = words.roles[spot.role];
  if (role) parts.push(role);
  return parts.join(words.separator);
}
