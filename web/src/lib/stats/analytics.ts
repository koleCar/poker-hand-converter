/**
 * The Analytics stat catalogue on the web (docs/ANALYTICS.md Step 1): the
 * statistics the Analytics screen checks against a target.
 *
 * `analytics.json` next to this file is a byte-for-byte copy of
 * `config/stats/analytics.json` (the web is built from `web/` alone; the
 * Rust test `the_web_copy_is_the_same_file` and `tests/test/analytics.test.ts`
 * fail when they differ). The desktop validates the file
 * (`core/rail-stats/src/analytics.rs`); this module reads it, compiles each
 * rate's predicate (`predicate.ts`) and gives the same counts, the same
 * per-decision membership and the same hand classes as the Rust twin - held
 * equal over the golden corpus (`testdata/golden-analytics/`).
 *
 * Three kinds of entry:
 *
 * - `rate`: `count` is `mode opportunity => action` in the decision-event
 *   language; the action is exactly the stat's action class. It counts the
 *   hero and every opponent.
 * - `share`: of the actions of the rate `of`, the share made with a hand
 *   class in `weak` (hero only: it needs the cards).
 * - `coded`: a shipped statistic of `standard.json` (`definitions.json`),
 *   shown with no target.
 *
 * **Membership** - for a rate in `first` or `any` mode, the seat's first
 * event that passes the opportunity (one per hand); `each` every passing
 * event - each with whether the decision took the class's action. It is
 * what the analysis rows of a decision carry (Step 2): the target of a rate
 * is the mean, over its member decisions, of the reference's frequency for
 * the class.
 */

import file from "./analytics.json";
import type { HandEvents, SeatEvents } from "./events";
import { handEvents } from "./events";
import type { Counts, Predicate } from "./predicate";
import { countSeat, members, parsePredicate } from "./predicate";
import type { PhfHand } from "../phf/types";

/**
 * What a stored decision's membership was computed under (Step 2): the
 * Rust `MEMBERSHIP_VERSION`, bumped whenever a rate's id, class or count
 * changes. Both test suites pin `membershipFingerprint()` to it, and
 * `rowsFingerprint()` (the hand classes and size buckets a checker row
 * reads): a change there, or to `analyticsRows.ts`, bumps it too.
 */
export const ANALYTICS_MEMBERSHIP_VERSION = "analytics/1";

export type AnalyticsStreet = "preflop" | "flop" | "turn" | "river" | "showdown";
export type ActionClass = "fold" | "call" | "raise" | "bet" | "vpip" | "pfr";
export type DecisionAction = "fold" | "check" | "call" | "bet" | "raise";

export interface AnalyticsText {
  en: string;
  hr: string;
}

export interface HandClassDef {
  id: string;
  label: AnalyticsText;
  made?: string[];
  draws?: string[];
}

/** A bet-size bucket: `min` in thousandths of the pot (400 = 40%). */
export interface SizeBucketDef {
  id: string;
  min: number;
  label: AnalyticsText;
}

export interface StatGroupDef {
  id: string;
  street: AnalyticsStreet;
  label: AnalyticsText;
}

interface StatCommon {
  id: string;
  street: AnalyticsStreet;
  group: string;
  family: string;
  label: AnalyticsText;
  sub?: AnalyticsText;
  words: { high: AnalyticsText; low: AnalyticsText };
  sample: { min: number };
  band: { floor: number };
}

export interface RateStat extends StatCommon {
  kind: "rate";
  count: string;
  class: ActionClass;
  coded?: string;
  within?: string;
}

export interface ShareStat extends StatCommon {
  kind: "share";
  of: string;
  weak: string[];
}

export interface CodedStat extends StatCommon {
  kind: "coded";
  coded: string;
}

export type CatalogueStat = RateStat | ShareStat | CodedStat;

export interface CatalogueFile {
  version: 1;
  actionClasses: Record<ActionClass, DecisionAction[]>;
  handClasses: HandClassDef[];
  sizeBuckets: SizeBucketDef[];
  groups: StatGroupDef[];
  families: string[];
  stats: CatalogueStat[];
}

/** A decision that belongs to one or more rates. */
export interface DecisionMembership {
  /** `Decision.order` (the analysis row's `ord`). */
  order: number;
  seat: number;
  /** `[index into stats, taken]`, in catalogue order. */
  stats: [number, boolean][];
}

export interface Catalogue {
  readonly file: CatalogueFile;
  readonly stats: readonly CatalogueStat[];
  /** Index-aligned with `stats`: the compiled predicate of a rate, null otherwise. */
  readonly predicates: readonly (Predicate | null)[];
  get(id: string): CatalogueStat | undefined;
  indexOf(id: string): number;
  /** Whether `action` is in the class. */
  inClass(cls: ActionClass, action: string): boolean;
  /** The hand class of a postflop decision (`facts.made.class`, `facts.draws`); null without a made hand. */
  handClass(made: string | null | undefined, draws: readonly string[]): HandClassDef | null;
  /**
   * The size bucket of a bet of `facingPot` (a fraction of the pot before
   * it, `facts.facingPot`): the last whose `min` the size, in thousandths
   * rounded half away from zero, reaches. Null for no bet.
   */
  sizeBucket(facingPot: number | null | undefined): SizeBucketDef | null;
  /** One seat's counts of every stat, index-aligned with `stats` (0/0 for share and coded). */
  counts(hand: HandEvents, seat: SeatEvents): Counts[];
  /** Every decision of the hand that belongs to a rate, in decision order. */
  membership(hand: HandEvents): DecisionMembership[];
}

/** Compile a catalogue file (the shipped one is `ANALYTICS`). Throws when a predicate does not parse. */
export function compileCatalogue(source: CatalogueFile): Catalogue {
  if (source.version !== 1) {
    throw new Error(`analytics catalogue version ${String(source.version)}, expected 1`);
  }
  const stats = source.stats;
  const predicates = stats.map((stat) => {
    if (stat.kind !== "rate") return null;
    try {
      return parsePredicate(stat.count);
    } catch (error) {
      throw new Error(`${stat.id}: ${(error as Error).message}`);
    }
  });
  const byId = new Map(stats.map((stat, index) => [stat.id, index]));
  return {
    file: source,
    stats,
    predicates,
    get: (id) => {
      const index = byId.get(id);
      return index === undefined ? undefined : stats[index];
    },
    indexOf: (id) => byId.get(id) ?? -1,
    inClass: (cls, action) => (source.actionClasses[cls] as readonly string[]).includes(action),
    handClass: (made, draws) => {
      if (!made) return null;
      return (
        source.handClasses.find(
          (cls) =>
            (cls.made === undefined || cls.made.includes(made)) &&
            (cls.draws === undefined || cls.draws.some((draw) => draws.includes(draw))),
        ) ?? null
      );
    },
    sizeBucket: (facingPot) => {
      if (typeof facingPot !== "number" || !Number.isFinite(facingPot) || facingPot <= 0) return null;
      const thousandths = Math.round(facingPot * 1000);
      for (let i = source.sizeBuckets.length - 1; i >= 0; i -= 1) {
        if (thousandths >= source.sizeBuckets[i].min) return source.sizeBuckets[i];
      }
      return null;
    },
    counts: (hand, seat) =>
      predicates.map((predicate) => (predicate ? countSeat(predicate, hand, seat) : { made: 0, opp: 0 })),
    membership: (hand) => {
      const byOrder = new Map<number, DecisionMembership>();
      for (const seat of hand.seats) {
        predicates.forEach((predicate, index) => {
          if (!predicate) return;
          for (const { event, taken } of members(predicate, hand, seat)) {
            let entry = byOrder.get(event.order);
            if (!entry) {
              entry = { order: event.order, seat: seat.seat, stats: [] };
              byOrder.set(event.order, entry);
            }
            entry.stats.push([index, taken]);
          }
        });
      }
      return [...byOrder.values()].sort((a, b) => a.order - b.order);
    },
  };
}

/** The rates as the membership reads them, one `id|class|count` line each. */
export function membershipFingerprint(catalogue: Catalogue = ANALYTICS): string {
  return catalogue.stats
    .filter((stat): stat is RateStat => stat.kind === "rate")
    .map((stat) => `${stat.id}|${stat.class}|${stat.count}\n`)
    .join("");
}

/**
 * What a stored checker row reads besides the rates (Step 2): the hand
 * classes (`class|id|made|draws`) and the size buckets (`size|id|min`), one
 * line each - the Rust `Catalogue::rows_fingerprint`, pinned with the
 * membership version by both test suites.
 */
export function rowsFingerprint(catalogue: Catalogue = ANALYTICS): string {
  const list = (items: string[] | undefined) => (items === undefined ? "*" : items.join(","));
  const classes = catalogue.file.handClasses.map((cls) => `class|${cls.id}|${list(cls.made)}|${list(cls.draws)}\n`);
  const sizes = catalogue.file.sizeBuckets.map((bucket) => `size|${bucket.id}|${bucket.min}\n`);
  return [...classes, ...sizes].join("");
}

/** The shipped catalogue. */
export const ANALYTICS: Catalogue = compileCatalogue(file as CatalogueFile);

/**
 * The membership of a hand's decisions, by decision order: what Step 2
 * stores with each analysed decision (the hero's rows; `seat` says whose).
 */
export function decisionMembership(hand: PhfHand, catalogue: Catalogue = ANALYTICS): DecisionMembership[] {
  return catalogue.membership(handEvents(hand));
}
