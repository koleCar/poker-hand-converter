/**
 * The database side of the statistics engine.
 *
 * `lib/stats/**` derives the numbers and may import nothing but `lib/phf` and
 * `lib/cards` — that import rule is what lets `backend/test/` run it over the
 * whole corpus and what will let a server-side backfill run the identical
 * function later. So everything that knows about Supabase lives here instead:
 * the wire shape, the writer, and the two reports.
 *
 * The split of labour, restated because it is easy to erode:
 *
 *   * **Semantics** are in `lib/stats`. What a 3-bet opportunity is, whether a
 *     walk counts, which street a cbet chain survives to.
 *   * **Arithmetic** is in SQL. `sum()`, `group by`, `ntile()`, and nothing
 *     else — see `supabase/migrations/20261005090000_hand_stats.sql`.
 *   * **Presentation** is `rates()`, from `lib/stats`, called on the sums this
 *     module fetches. Not a re-implementation: the dashboard divides with the
 *     same function the corpus suite asserts against, so a rate on the screen
 *     and a rate in a test cannot disagree.
 */

import {
  handFacts,
  statsRows,
  STATS_VERSION,
  emptyCounters,
  emptyMoney,
  COUNTER_KEYS,
  MONEY_KEYS,
  type SeatCounters,
  type SeatMoney,
  type StatsRow,
} from "../stats";
import type { PhfHand } from "../phf/types";
import { currentUserId, requireUserId, rpc } from "./client";
import { detectAnonymization } from "./anonymization";
import type { SiteAnonymization } from "./types";

/* ------------------------------------------------------------- the wire - */

/**
 * One row as `save_hand_stats` takes it.
 *
 * Almost exactly a `StatsRow`: the two differences are `hand_id`, which in a
 * derived row is the *site's* hand id and in the table is the `hands.id` uuid
 * the server resolves, and `site_anonymization`, which is a property of how the
 * room publishes names rather than of the hand's play and therefore is not
 * something `lib/stats` has any business knowing about.
 */
export type HandStatsInsert = Omit<StatsRow, "hand_id"> & {
  site_hand_id: string;
  site_anonymization: SiteAnonymization;
};

/**
 * Whether villain rows are written.
 *
 * The schema has carried a row per dealt-in seat since the first migration, on
 * purpose: hero-only would be a one-way door on opponent statistics, and a
 * table that cannot grow into a HUD would have to be rewritten to get one. But
 * per-player multiplies the row count by about six, and at 500k hands that is
 * ~3M rows, which does not fit the free tier. So the schema is ready and the
 * writer is not — turning villains on is this flag, not a migration.
 *
 * Read through a `try` because Safari in private browsing throws on
 * `localStorage`, and a storage quirk must not be able to stop a save.
 */
const VILLAIN_ROWS_KEY = "pokerconverter.statsVillains";

export function villainRowsEnabled(): boolean {
  try {
    return localStorage.getItem(VILLAIN_ROWS_KEY) === "on";
  } catch {
    return false;
  }
}

export interface DeriveOptions {
  /** Defaults to {@link villainRowsEnabled}. */
  includeVillains?: boolean;
}

/**
 * Derives the rows for one hand, in the shape the writer sends.
 *
 * **Villain rows are never emitted for a positionally anonymised room.** An
 * Ignition "UTG+1" is a different human every hand, so a per-player row keyed on
 * that name would quietly average strangers together and look exactly like a
 * real opponent report while doing it. That rule is enforced here *and* by
 * `hand_stats_positional_anonymity` in the migration: this is the copy that
 * keeps a batch from being rejected, the constraint is the copy that makes the
 * mistake impossible.
 */
export function handStatsRows(hand: PhfHand, options: DeriveOptions = {}): HandStatsInsert[] {
  const anonymization = detectAnonymization(hand);
  const villains =
    (options.includeVillains ?? villainRowsEnabled()) && anonymization !== "positional";

  return statsRows(handFacts(hand))
    .filter((row) => row.is_hero || villains)
    .map(({ hand_id: siteHandId, ...row }) => ({
      ...row,
      site_hand_id: siteHandId,
      site_anonymization: anonymization,
    }));
}

export interface SaveHandStatsResult {
  received: number;
  inserted: number;
  duplicates: number;
  /** Rows whose hand is not in the caller's library. Not an error — see below. */
  skipped: number;
  errors: string[];
}

/** The RPC's own ceiling is 1000 rows; batch a little under it. */
const MAX_ROWS_PER_REQUEST = 500;

/**
 * Derives and stores statistics for hands that are already in the library.
 *
 * Deliberately **not** part of `saveHands()`. The hands are the irreplaceable
 * thing a user uploaded; statistics are a pure function of a `phf` document
 * that is now sitting in the database, so they can be re-derived at any time.
 * Chaining them would mean a statistics failure could surface as "your upload
 * failed", which is both untrue and the most expensive lie this app could tell.
 * So this runs after the save, reports its own outcome, and a caller is free to
 * ignore it.
 *
 * `skipped` counts rows naming a hand the caller does not own — which is what a
 * statistics row for a hand whose insert was itself rejected looks like. It is
 * a number to report, never an error to throw: the hands are safe either way.
 */
export async function saveHandStats(
  hands: PhfHand[],
  options: DeriveOptions = {},
): Promise<SaveHandStatsResult> {
  const result: SaveHandStatsResult = {
    received: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    errors: [],
  };
  if (hands.length === 0) {
    return result;
  }
  await requireUserId();

  // Dedupe inside the batch first, on the same key the table is keyed by. A
  // file containing the same hand twice should not spend a round trip finding
  // that out, and `save_hand_stats` would only drop the second copy anyway.
  const seen = new Set<string>();
  const rows: HandStatsInsert[] = [];
  for (const hand of hands) {
    for (const row of handStatsRows(hand, options)) {
      const key = `${row.hand_key}|${row.stats_version}|${row.seat}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  }
  result.received = rows.length;

  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_REQUEST) {
    const batch = rows.slice(i, i + MAX_ROWS_PER_REQUEST);
    try {
      const payload = await rpc<{
        inserted?: number;
        duplicates?: number;
        skipped?: number;
      }>("save_hand_stats", { p_rows: batch });
      result.inserted += payload.inserted ?? 0;
      result.duplicates += payload.duplicates ?? 0;
      result.skipped += payload.skipped ?? 0;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return result;
}

/* --------------------------------------------------------------- reading - */

/**
 * The filters both reports accept.
 *
 * Every key is optional and every one is bound as a placeholder server-side —
 * nothing here is interpolated into SQL. The three `include*` keys are the
 * default exclusions, spelled out so a caller can see what is being left out
 * rather than discovering it in a discrepancy.
 */
export interface StatsFilters {
  statsVersion?: string;
  from?: string;
  to?: string;
  site?: string;
  variant?: string;
  limitType?: string;
  gameFormat?: string;
  currency?: string;
  bigBlind?: number;
  positions?: string[];
  handClasses?: string[];
  tournamentId?: string;
  /** A specific fast-fold brand, e.g. "Zoom". */
  fastFold?: string;
  /** `true` for fast-fold tables only, `false` for regular tables only. */
  fastFoldOnly?: boolean;
  minPlayers?: number;
  maxPlayers?: number;
  /** Bomb pots are out of everything by default; every preflop opp in one is 0. */
  includeBombPots?: boolean;
  /** Straddled hands are in by default; their positions just mean something else. */
  includeStraddled?: boolean;
  /** EV-cashout hands are out of the **money** series by default. */
  includeCashouts?: boolean;
}

/**
 * Why a money figure is missing, when it is.
 *
 * Both are refusals rather than failures. The server will not add dollars to
 * euros and will not add tournament chips to cash, because both sums render
 * perfectly and mean nothing — and a number that looks right and is not is
 * worse than a blank.
 */
export interface MoneyUnitState {
  /**
   * The sample spans more than one currency. Big blinds survive (a big blind is
   * a unit of the game, not of a currency, which is the whole reason
   * `net_bb_milli` exists); the currency figures do not.
   */
  mixedCurrency: boolean;
  /**
   * The sample mixes tournament chips with cash. Nothing denominated survives,
   * big blinds included: a tournament big blind is a fraction of a shrinking
   * stack and a cash big blind is a fixed price.
   */
  mixedUnitKind: boolean;
  moneyAvailable: boolean;
  currency: string | null;
  currencyMinorUnits: number | null;
}

export interface StatsSummary extends MoneyUnitState {
  statsVersion: string;
  hands: number;
  /**
   * Hands whose money was counted. Lower than `hands` whenever the sample holds
   * EV cashouts, which is why bb/100 divides by this and not by the hand count.
   */
  moneyHands: number;
  counters: SeatCounters;
  /** Null when the units refuse to be summed; see {@link MoneyUnitState}. */
  money: SeatMoney | null;
  firstHandAt: string | null;
  lastHandAt: string | null;
}

export interface StatsGraphBucket {
  bucket: number;
  hands: number;
  moneyHands: number;
  firstPlayedAt: string | null;
  lastPlayedAt: string | null;
  cumHands: number;
  cumMoneyHands: number;
  /** Cumulative result, in thousandths of a big blind. */
  cumNetBbMilli: number;
  /** ...of it won in hands that reached showdown. */
  cumSdBbMilli: number;
  /** ...and in hands that did not. The two sum to `cumNetBbMilli`. */
  cumNsdBbMilli: number;
  /** Cumulative result in minor units, or null across mixed currencies. */
  cumNet: number | null;
}

export interface StatsGraph extends MoneyUnitState {
  statsVersion: string;
  hands: number;
  moneyHands: number;
  buckets: StatsGraphBucket[];
  /** Reserved for the all-in EV series (#44). Always null today. */
  allInEv: null;
}

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const maybeNum = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value);
const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Fills a full counter set from whatever the server sent.
 *
 * Starting from `emptyCounters()` rather than casting the payload is what makes
 * a counter that the database does not have yet read as 0 instead of
 * `undefined` — which would turn every rate that touched it into `NaN` and
 * render as "NaN%" on a dashboard. Version skew between a deployed client and a
 * not-yet-migrated database is the normal case during a rollout, not an edge.
 */
function toCounters(payload: unknown): SeatCounters {
  const row = (payload ?? {}) as Row;
  const counters = emptyCounters();
  for (const key of COUNTER_KEYS) {
    counters[key] = num(row[key]);
  }
  return counters;
}

function toMoney(payload: unknown): SeatMoney | null {
  if (payload === null || payload === undefined) {
    return null;
  }
  const row = payload as Row;
  const money = emptyMoney();
  for (const key of MONEY_KEYS) {
    money[key] = num(row[key]);
  }
  return money;
}

function toUnitState(payload: Row): MoneyUnitState {
  return {
    mixedCurrency: payload.mixedCurrency === true,
    mixedUnitKind: payload.mixedUnitKind === true,
    moneyAvailable: payload.moneyAvailable !== false,
    currency: str(payload.currency),
    currencyMinorUnits: maybeNum(payload.currencyMinorUnits),
  };
}

/** Everything at zero, for the signed-out and not-configured paths. */
export function emptyStatsSummary(): StatsSummary {
  return {
    statsVersion: STATS_VERSION,
    hands: 0,
    moneyHands: 0,
    counters: emptyCounters(),
    money: emptyMoney(),
    mixedCurrency: false,
    mixedUnitKind: false,
    moneyAvailable: true,
    currency: null,
    currencyMinorUnits: null,
    firstHandAt: null,
    lastHandAt: null,
  };
}

export function emptyStatsGraph(): StatsGraph {
  return {
    statsVersion: STATS_VERSION,
    hands: 0,
    moneyHands: 0,
    buckets: [],
    mixedCurrency: false,
    mixedUnitKind: false,
    moneyAvailable: true,
    currency: null,
    currencyMinorUnits: null,
    allInEv: null,
  };
}

/**
 * Every counter, summed over the caller's own hands.
 *
 * Returns the empty summary rather than throwing when signed out, for the same
 * reason `searchHands` returns an empty page: the statistics screen is a place
 * a signed-out visitor is allowed to be, and "0 hands" under a sign-in prompt
 * reads better than a red error about a session.
 *
 * Note what is *not* here: no rate, no percentage, no average. The server
 * returns sums; `rates()` from `lib/stats` divides them. That is the only
 * arrangement in which two samples can be combined, and it is why nothing in
 * this file does arithmetic.
 */
export async function fetchStatsSummary(filters: StatsFilters = {}): Promise<StatsSummary> {
  if (!(await currentUserId())) {
    return emptyStatsSummary();
  }
  const payload = await rpc<Row | null>("stats_summary", { p_filters: filters });
  if (!payload) {
    return emptyStatsSummary();
  }
  return {
    statsVersion: String(payload.statsVersion ?? STATS_VERSION),
    hands: num(payload.hands),
    moneyHands: num(payload.moneyHands),
    counters: toCounters(payload.counters),
    money: toMoney(payload.money),
    firstHandAt: str(payload.firstHandAt),
    lastHandAt: str(payload.lastHandAt),
    ...toUnitState(payload),
  };
}

/**
 * The cumulative win-rate series, bucketed by hand count.
 *
 * `buckets` is a resolution, not a time step. The server uses `ntile()` over
 * the hand ordering rather than `date_trunc()`, so a three-month break does not
 * get three months of x-axis for zero volume — the x-axis is cumulative hands,
 * and the date range of each bucket comes back alongside for the tooltip.
 */
export async function fetchStatsGraph(
  filters: StatsFilters = {},
  buckets = 60,
): Promise<StatsGraph> {
  if (!(await currentUserId())) {
    return emptyStatsGraph();
  }
  const payload = await rpc<Row | null>("stats_graph", {
    p_filters: filters,
    p_buckets: buckets,
  });
  if (!payload) {
    return emptyStatsGraph();
  }
  const rows = Array.isArray(payload.buckets) ? (payload.buckets as Row[]) : [];
  return {
    statsVersion: String(payload.statsVersion ?? STATS_VERSION),
    hands: num(payload.hands),
    moneyHands: num(payload.moneyHands),
    buckets: rows.map((row) => ({
      bucket: num(row.bucket),
      hands: num(row.hands),
      moneyHands: num(row.money_hands),
      firstPlayedAt: str(row.first_played_at),
      lastPlayedAt: str(row.last_played_at),
      cumHands: num(row.cum_hands),
      cumMoneyHands: num(row.cum_money_hands),
      cumNetBbMilli: num(row.cum_net_bb_milli),
      cumSdBbMilli: num(row.cum_sd_bb_milli),
      cumNsdBbMilli: num(row.cum_nsd_bb_milli),
      // Absent, not zero, when the sample spans currencies: the server removes
      // the key rather than returning a sum with no unit.
      cumNet: "cum_net" in row ? maybeNum(row.cum_net) : null,
    })),
    allInEv: null,
    ...toUnitState(payload),
  };
}
