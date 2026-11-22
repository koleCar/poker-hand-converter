/**
 * The Analytics checker rows (docs/ANALYTICS.md Step 2): what the stat
 * checker needs from each analysed decision, one row per (decision, rate it
 * belongs to). Both apps store them beside the analysis rows - the web in
 * `analysis_checker_rows` (written by `analytics_rows_save` from the
 * browser, where the analysis is made, and by the backfill), the desktop in
 * its rail-store twin (written in Rust, `core/rail-stats/src/analytics_rows.rs`,
 * the twin of this module) - and sum them by (stat, spot, size, hand class).
 *
 * A row holds:
 *
 * - `stat` and `taken`: the catalogue rate the decision belongs to and
 *   whether it took the rate's action class (`decisionMembership`, the
 *   hero's entry for the decision's `ord`);
 * - `refShare`: Σ of the reference frequencies of the options in the
 *   class (the hand-adjusted target's share), `bestIn`: whether the
 *   reference's best option (highest EV; ties: higher frequency, then first
 *   listed - `analysis_best_action`) is in the class. Both null for a
 *   decision that was not analysed (no options);
 * - `evLossBb`: the decision's EV loss, 0 without one (the leak rows'
 *   reading), to 3 decimals;
 * - `size`: the size bucket of the bet faced after the flop
 *   (`ANALYTICS.sizeBucket(facts.facingPot)`), '' preflop or with no bet;
 * - `handClass`: `ANALYTICS.handClass(facts.made.class, facts.draws)`, ''
 *   preflop;
 * - `spot`: `pot|role|hero|opponent` ({@link spotKey}): named for the
 *   screens by `packages/ui/analytics/spot.ts`;
 * - `multiway`: the decision's scenario is a multiway one (`-mw-`), for the
 *   readers' `potKind` filter as the leak rows read it.
 *
 * The numbers are rounded here (`refShare` to 6 decimals, `evLossBb` to 3,
 * half away from zero) as the Rust twin rounds them, so a fixture gives the
 * same sums in both apps (`core/rail-stats/tests/data/analytics/rows/`).
 *
 * A change to anything this module derives - beyond the catalogue's rates,
 * hand classes and size buckets, which the version's pins cover - bumps
 * `ANALYTICS_MEMBERSHIP_VERSION` (and the Rust `MEMBERSHIP_VERSION`): the
 * stored rows of another version are what the backfill derives again.
 */

import type { PhfHand } from "../phf/types";
import type { ActionClass, Catalogue, RateStat } from "./analytics";
import { ANALYTICS } from "./analytics";
import type { HandEvents } from "./events";
import { handEvents } from "./events";

/** One option of a stored decision, as far as the rows read it. */
export interface RowsOptionIn {
  action: string;
  freq?: number | null;
  ev?: number | null;
}

/**
 * One stored decision, as far as the rows read it: `save_hand_analysis`'s
 * decision shape (`DecisionAnalysisInsert`) and the desktop's `DecisionRowIn`.
 */
export interface RowsDecisionIn {
  ord: number;
  action_index: number;
  status: string;
  options: readonly RowsOptionIn[] | null | undefined;
  ev_loss_bb: number | null | undefined;
  facts: RowsFactsIn | null | undefined;
}

/** The facts the rows read (`SpotFacts`). */
export interface RowsFactsIn {
  street?: string | null;
  scenario?: string | null;
  preflopScenario?: string | null;
  role?: string | null;
  facingPot?: number | null;
  made?: { class?: string | null } | null;
  draws?: readonly string[] | null;
}

/** One checker row. */
export interface AnalyticsRow {
  ord: number;
  actionIndex: number;
  stat: string;
  taken: boolean;
  refShare: number | null;
  bestIn: boolean | null;
  evLossBb: number;
  size: string;
  handClass: string;
  spot: string;
  multiway: boolean;
}

/** `x` to `places` decimals, half away from zero (Rust's `f64::round`, Postgres' numeric `round`). */
export function roundHalfAway(x: number, places: number): number {
  const scale = 10 ** places;
  const scaled = Math.round(Math.abs(x) * scale) / scale;
  return x < 0 ? -scaled : scaled;
}

/** The action of the best option: highest EV, then higher frequency, then first listed (`analysis_best_action`). */
export function bestOption(options: readonly RowsOptionIn[]): string | null {
  let best: { action: string; ev: number | null; freq: number | null } | null = null;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  for (const option of options) {
    if (!["fold", "check", "call", "bet", "raise"].includes(option.action)) continue;
    const candidate = { action: option.action, ev: num(option.ev), freq: num(option.freq) };
    if (best === null) {
      best = candidate;
      continue;
    }
    // EV descending, nulls last; then frequency descending, nulls last; then the first.
    const ev = compareDesc(candidate.ev, best.ev);
    if (ev < 0 || (ev === 0 && compareDesc(candidate.freq, best.freq) < 0)) best = candidate;
  }
  return best?.action ?? null;
}

/** < 0 when `a` sorts before `b` in "descending, nulls last". */
function compareDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** The pot of a postflop decision: `bomb`, else by the preflop raises (`potTypeOf`'s words). */
export function potOf(hand: HandEvents): string {
  if (hand.bombPot) return "bomb";
  if (hand.preflopRaises === 0) return "limped";
  if (hand.preflopRaises === 1) return "single-raised";
  if (hand.preflopRaises === 2) return "3bet";
  return "4bet+";
}

/**
 * The opponent of the hero's decision `order` on `street`: the last seat to
 * bet or raise on the street before it; else, after the flop, the one
 * opponent left (`multi` with two or more, '' with none); preflop with no
 * raise, ''.
 */
export function opponentOf(hand: HandEvents, heroSeat: number, order: number, street: string): string {
  let aggressor: { order: number; position: string } | null = null;
  const live: string[] = [];
  for (const seat of hand.seats) {
    if (seat.seat === heroSeat) continue;
    let folded = false;
    for (const event of seat.events) {
      if (event.order >= order) continue;
      if (event.action === "fold") folded = true;
      if (
        event.street === street &&
        (event.action === "bet" || event.action === "raise") &&
        (aggressor === null || event.order > aggressor.order)
      ) {
        aggressor = { order: event.order, position: seat.position ?? "" };
      }
    }
    if (!folded) live.push(seat.position ?? "");
  }
  if (aggressor) return aggressor.position;
  if (street === "preflop") return "";
  if (live.length === 1) return live[0];
  return live.length === 0 ? "" : "multi";
}

/**
 * A decision's spot: `pot|role|hero|opponent`. Preflop: no pot, the role is
 * the preflop scenario (`unopened`, `vs-open`, ...). After the flop: the
 * pot ({@link potOf}), the hero's role (`pfr`, `caller`, `limped`, `bomb`).
 * The hero's and the opponent's positions are the PHF's.
 */
export function spotKey(pot: string, role: string, hero: string, opponent: string): string {
  return `${pot}|${role}|${hero}|${opponent}`;
}

/**
 * The checker rows of one hand: one per (hero decision, rate it belongs to),
 * in decision order then catalogue order. `decisions` are the hand's stored
 * analysis decisions; a member decision without one is left out (it was not
 * analysed at all), and so is a decision in no rate.
 */
export function analyticsRows(
  hand: PhfHand | HandEvents,
  decisions: readonly RowsDecisionIn[],
  catalogue: Catalogue = ANALYTICS,
): AnalyticsRow[] {
  const events: HandEvents = "seats" in hand && "preflopRaises" in hand ? hand : handEvents(hand);
  const hero = events.seats.find((seat) => seat.hero);
  if (!hero) return [];
  const membership = new Map(
    catalogue
      .membership(events)
      .filter((entry) => entry.seat === hero.seat)
      .map((entry) => [entry.order, entry]),
  );
  const streetOf = new Map(hero.events.map((event) => [event.order, event.street as string]));
  const rows: AnalyticsRow[] = [];
  for (const decision of [...decisions].sort((a, b) => a.ord - b.ord)) {
    const entry = membership.get(decision.ord);
    if (!entry) continue;
    const facts = decision.facts ?? {};
    const street = streetOf.get(decision.ord) ?? facts.street ?? "";
    const preflop = street === "preflop";
    const options = Array.isArray(decision.options) ? decision.options : [];
    const analysed = decision.status === "analysed" && options.length > 0;
    const best = analysed ? bestOption(options) : null;
    const made = facts.made?.class ?? null;
    const spot = spotKey(
      preflop ? "" : potOf(events),
      (preflop ? facts.preflopScenario : facts.role) ?? "",
      hero.position ?? "",
      opponentOf(events, hero.seat, decision.ord, street),
    );
    const size = preflop ? "" : (catalogue.sizeBucket(facts.facingPot)?.id ?? "");
    const handClass = preflop ? "" : (catalogue.handClass(made, facts.draws ?? [])?.id ?? "");
    const evLossBb = roundHalfAway(typeof decision.ev_loss_bb === "number" ? decision.ev_loss_bb : 0, 3);
    const multiway = (facts.scenario ?? "").includes("-mw-");
    for (const [index, taken] of entry.stats) {
      const stat = catalogue.stats[index] as RateStat;
      const cls: ActionClass = stat.class;
      let refShare: number | null = null;
      if (analysed) {
        let sum = 0;
        for (const option of options) {
          if (typeof option.freq === "number" && Number.isFinite(option.freq) && catalogue.inClass(cls, option.action)) {
            sum += option.freq;
          }
        }
        refShare = roundHalfAway(sum, 6);
      }
      rows.push({
        ord: decision.ord,
        actionIndex: decision.action_index,
        stat: stat.id,
        taken,
        refShare,
        bestIn: analysed ? best !== null && catalogue.inClass(cls, best) : null,
        evLossBb,
        size,
        handClass,
        spot,
        multiway,
      });
    }
  }
  return rows;
}
