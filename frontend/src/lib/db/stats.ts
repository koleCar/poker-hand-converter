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
  STATS_VERSION,
  emptyCounters,
  emptyMoney,
  COUNTER_KEYS,
  MONEY_KEYS,
  type SeatCounters,
  type SeatMoney,
} from "../stats";
import { EV_VERSION } from "../equity";
import type { PhfHand } from "../phf/types";
import { currentUserId, requireUserId, rpc } from "./client";
import {
  handStatsRows,
  villainRowsEnabled,
  type DeriveOptions,
  type HandStatsInsert,
} from "./statsRows";

export {
  handStatsRows,
  setVillainRowsEnabled,
  villainRowsEnabled,
  type DeriveOptions,
  type HandStatsInsert,
} from "./statsRows";

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
  /**
   * Cumulative all-in-EV result in thousandths of a big blind: the total line
   * with the luck of all-in runouts taken out. Equals `cumNetBbMilli` until a
   * hand with an all-in is evaluated.
   */
  cumEvBbMilli: number;
}

/** How much of the sample the EV line is actually about. */
export interface AllInEvSummary {
  evVersion: string;
  /** Hands with an EV row: the line is exact for these. */
  evaluatedHands: number;
  /** Of those, hands with an all-in and cards to come. */
  allInHands: number;
}

export interface StatsGraph extends MoneyUnitState {
  statsVersion: string;
  hands: number;
  moneyHands: number;
  buckets: StatsGraphBucket[];
  /** Null when the server predates EV, or the sample has no money. */
  allInEv: AllInEvSummary | null;
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
      cumEvBbMilli: "cum_ev_bb_milli" in row ? num(row.cum_ev_bb_milli) : num(row.cum_net_bb_milli),
    })),
    allInEv:
      payload.allInEv && typeof payload.allInEv === "object"
        ? {
            evVersion: str((payload.allInEv as Row).evVersion) ?? "ev/1",
            evaluatedHands: num((payload.allInEv as Row).evaluatedHands),
            allInHands: num((payload.allInEv as Row).allInHands),
          }
        : null,
    ...toUnitState(payload),
  };
}

/* -------------------------------------------------------------- rebuild - */

/** How many of the caller's hands the numbers are actually about. */
export interface StatsCoverage {
  statsVersion: string;
  /** Hands that can have hero statistics. */
  hands: number;
  /** ... and have them under the current version. */
  atVersion: number;
  /** ... have them only under an older version. */
  stale: number;
  /** ... have none at all (uploaded before statistics, or a failed write). */
  missing: number;
  /** Hands with no hero seat — an observed table. Never counted as missing. */
  withoutHero: number;
  /** Rows under older versions, which the next rebuild prunes. */
  obsoleteRows: number;
  /** Hands with statistics but no all-in EV evaluation yet. */
  evMissing: number;
  /** The formats and stakes in the library, biggest first. */
  stakes: StakeVolume[];
}

/** One (format, currency, blinds) combination and how many hero hands it has. */
export interface StakeVolume {
  gameFormat: string;
  currency: string;
  currencyMinorUnits: number;
  smallBlind: number | null;
  bigBlind: number | null;
  hands: number;
}

export async function fetchStatsCoverage(): Promise<StatsCoverage | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const [payload, evMissing] = await Promise.all([
    rpc<Row | null>("stats_coverage", { p_version: STATS_VERSION }),
    // A database without the EV migration simply has nothing to catch up on.
    rpc<number>("stats_ev_missing", { p_version: STATS_VERSION, p_ev_version: EV_VERSION }).catch(() => 0),
  ]);
  if (!payload) {
    return null;
  }
  return {
    statsVersion: String(payload.statsVersion ?? STATS_VERSION),
    hands: num(payload.hands),
    atVersion: num(payload.atVersion),
    stale: num(payload.stale),
    missing: num(payload.missing),
    withoutHero: num(payload.withoutHero),
    obsoleteRows: num(payload.obsoleteRows),
    evMissing: num(evMissing),
    stakes: (Array.isArray(payload.stakes) ? (payload.stakes as Row[]) : []).map((row) => ({
      gameFormat: str(row.gameFormat) ?? "cash",
      currency: str(row.currency) ?? "",
      currencyMinorUnits: num(row.currencyMinorUnits) || 100,
      smallBlind: maybeNum(row.smallBlind),
      bigBlind: maybeNum(row.bigBlind),
      hands: num(row.hands),
    })),
  };
}

export interface RebuildProgress {
  processed: number;
  inserted: number;
  failed: number;
  pruned: number;
}

/**
 * Derives statistics for every stored hand that lacks them, server-side.
 *
 * Calls `POST /api/stats/rebuild` slice by slice until it reports `done`. The
 * documents never come to the browser: the route reads them next to the
 * database, as this user, and answers with counts. Safe to run twice at once
 * (after an upload *and* from the statistics screen, say) — every write is
 * `on conflict do nothing`, and "what is missing" is recomputed per slice.
 */
export async function rebuildStats(
  onProgress?: (progress: RebuildProgress) => void,
): Promise<RebuildProgress> {
  const total: RebuildProgress = { processed: 0, inserted: 0, failed: 0, pruned: 0 };
  if (!(await currentUserId())) {
    return total;
  }
  let after: string | null = null;
  // Bounded so a server that never says `done` cannot spin a tab forever:
  // 2000 slices of 8 s is far beyond any library this app could hold.
  for (let slice = 0; slice < 2000; slice += 1) {
    const response = await fetch("/api/stats/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ after, includeVillains: villainRowsEnabled() }),
    });
    const payload = (await response.json().catch(() => ({}))) as Row;
    if (!response.ok) {
      throw new Error(str(payload.error) ?? `Rebuilding statistics failed (${response.status}).`);
    }
    total.processed += num(payload.processed);
    total.inserted += num(payload.inserted);
    total.failed += num(payload.failed);
    total.pruned += num(payload.pruned);
    onProgress?.({ ...total });
    if (payload.done === true) {
      break;
    }
    after = str(payload.after);
  }
  return total;
}

/* ------------------------------------------------------------ breakdown - */

/** The dimensions `stats_breakdown` will split by. Anything else is a 22023. */
export type BreakdownGroup =
  | "position"
  | "table_size"
  | "site"
  | "stakes"
  | "hand_class"
  | "stack_bb";

export interface BreakdownRow {
  /** The group value: "BTN", "AKs", "6", "USD:50:100", "100-150"; null when unknown. */
  key: string | null;
  /**
   * The row as the HUD's own types, so `rates()` divides it. Only the counters
   * a breakdown carries are filled; the rest are zero, and the table shows
   * only the ones that are filled.
   */
  counters: SeatCounters;
  /** Null when the sample's units refuse to be summed (chips with cash). */
  money: SeatMoney | null;
  moneyHands: number;
}

export interface StatsBreakdown {
  group: BreakdownGroup;
  rows: BreakdownRow[];
  mixedCurrency: boolean;
  mixedUnitKind: boolean;
  currency: string | null;
  currencyMinorUnits: number | null;
}

/**
 * Same filters as the summary, split by one dimension. The split is a `group
 * by` over columns already on the row; the dimension is whitelisted server-side.
 */
export async function fetchStatsBreakdown(
  filters: StatsFilters,
  group: BreakdownGroup,
): Promise<StatsBreakdown> {
  const empty: StatsBreakdown = {
    group,
    rows: [],
    mixedCurrency: false,
    mixedUnitKind: false,
    currency: null,
    currencyMinorUnits: null,
  };
  if (!(await currentUserId())) {
    return empty;
  }
  const payload = await rpc<Row | null>("stats_breakdown", { p_filters: filters, p_group: group });
  if (!payload) {
    return empty;
  }
  const rows = Array.isArray(payload.rows) ? (payload.rows as Row[]) : [];
  return {
    group,
    rows: rows.map((row) => {
      const counters = toCounters(row);
      const hasMoney = "net_bb_milli" in row;
      const money = hasMoney ? emptyMoney() : null;
      if (money) {
        money.net_bb_milli = num(row.net_bb_milli);
        money.net = num(row.net);
      }
      return { key: str(row.key), counters, money, moneyHands: num(row.money_hands) };
    }),
    mixedCurrency: payload.mixedCurrency === true,
    mixedUnitKind: payload.mixedUnitKind === true,
    currency: str(payload.currency),
    currencyMinorUnits: maybeNum(payload.currencyMinorUnits),
  };
}

/* ------------------------------------------------------------ opponents - */

export interface OpponentRow {
  site: string;
  player: string;
  /** Their counters, in the HUD's own shape so `rates()` divides them. */
  counters: SeatCounters;
  lastSeen: string | null;
  /** The caller's own result in the hands this opponent was dealt into; null when the scope mixes chips and cash. */
  heroNetBb: number | null;
  heroMoneyHands: number;
}

export interface StatsOpponents {
  rows: OpponentRow[];
  mixedUnitKind: boolean;
  /** Villain rows left out because the room's names do not survive a session. */
  opaqueRows: number;
  villainRows: number;
}

export interface OpponentFilters extends StatsFilters {
  /** Hide opponents seen in fewer hands than this. */
  minHands?: number;
}

/**
 * Opponents from rooms with persistent names, biggest sample first, with the
 * caller's own result against each. Prefix search on the name.
 */
export async function fetchStatsOpponents(
  filters: OpponentFilters,
  search = "",
  limit = 50,
): Promise<StatsOpponents> {
  const empty: StatsOpponents = { rows: [], mixedUnitKind: false, opaqueRows: 0, villainRows: 0 };
  if (!(await currentUserId())) {
    return empty;
  }
  const payload = await rpc<Row | null>("stats_opponents", {
    p_filters: filters,
    p_search: search || null,
    p_limit: limit,
  });
  if (!payload) {
    return empty;
  }
  const rows = Array.isArray(payload.rows) ? (payload.rows as Row[]) : [];
  return {
    rows: rows.map((row) => {
      const counters = toCounters(row);
      // The report sums postflop actions across streets; `rates()` adds the
      // three streets back up, so the flop slot carries the total.
      counters.bet_flop = num(row.bets);
      counters.raise_flop = num(row.raises);
      counters.call_flop = num(row.calls);
      counters.fold_flop = num(row.folds);
      const hasMoney = "hero_net_bb_milli" in row;
      return {
        site: str(row.site) ?? "",
        player: str(row.player) ?? "",
        counters,
        lastSeen: str(row.last_seen),
        heroNetBb: hasMoney ? num(row.hero_net_bb_milli) / 1000 : null,
        heroMoneyHands: num(row.hero_money_hands),
      };
    }),
    mixedUnitKind: payload.mixedUnitKind === true,
    opaqueRows: num(payload.opaqueRows),
    villainRows: num(payload.villainRows),
  };
}

/** Turning opponent statistics off: removes the caller's villain rows, in slices. */
export async function pruneVillainStats(): Promise<number> {
  let total = 0;
  for (let i = 0; i < 500; i += 1) {
    const payload = await rpc<{ deleted?: number; more?: boolean }>("prune_villain_stats", {});
    total += payload?.deleted ?? 0;
    if (!payload?.more) {
      break;
    }
  }
  return total;
}
