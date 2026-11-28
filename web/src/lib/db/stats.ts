/**
 * The database side of the statistics engine.
 *
 * `lib/stats/**` derives the numbers and may import nothing but `lib/phf` and
 * `lib/cards` — that import rule is what lets `tests/test/` run it over the
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

import type { GameKind } from "@rail/ui/hands/gameKind";
import {
  STATS_VERSION,
  emptyCounters,
  COUNTER_KEYS,
  type SeatCounters,
} from "../stats";
import type { PhfHand } from "../phf/types";
import type { HandFilter } from "@rail/ui/hands/model";
import { currentUserId, requireUserId, rpc } from "./client";
import {
  handDerivation,
  type DeriveOptions,
  type HandFactsInsert,
  type HandStatsInsert,
} from "./statsRows";

export {
  handDerivation,
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
  // The filter builder's facts (20271116130000), one row a hand, beside its statistics.
  const facts = new Map<string, HandFactsInsert>();
  for (const hand of hands) {
    const derivation = handDerivation(hand, options);
    if (derivation.facts) facts.set(derivation.facts.hand_key, derivation.facts);
    for (const row of derivation.stats) {
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
  // A failed facts write costs nothing but the builder's facts of those
  // hands, which the next rebuild derives again (`hands_needing_stats`).
  const factRows = [...facts.values()];
  for (let i = 0; i < factRows.length; i += MAX_ROWS_PER_REQUEST) {
    await rpc("save_hand_facts", { p_rows: factRows.slice(i, i + MAX_ROWS_PER_REQUEST) }).catch(() => undefined);
  }

  return result;
}

/* --------------------------------------------------------------- reading - */

/**
 * Every report reads one `stats_version`, and the server's default for a
 * caller that does not say is the first one (`stats/1`). So the client always
 * says: without this, bumping `STATS_VERSION` would rebuild every library and
 * then keep reading the rows it had just made obsolete.
 */
function withVersion<T extends { statsVersion?: string }>(filters: T): T {
  return { statsVersion: STATS_VERSION, ...filters };
}

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
  /** One kind of game: cash, or every tournament format (`stats_opponents` reads it). */
  gameKind?: GameKind;
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

/* ---------------------------------------------------------------- stakes - */

/** One (format, currency, blinds) combination and how many hero hands it has. */
export interface StakeVolume {
  gameFormat: string;
  currency: string;
  currencyMinorUnits: number;
  smallBlind: number | null;
  bigBlind: number | null;
  hands: number;
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
    p_filters: withVersion(filters),
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

/* ------------------------------------------------------------- sessions - */

export interface StatsSession {
  startedAt: string;
  endedAt: string;
  hands: number;
  tables: number;
  /** Null when the scope mixes chips and cash. */
  netBbMilli: number | null;
  /** Minor units; null across currencies or chips-with-cash. */
  net: number | null;
}

export interface StatsSessions {
  gapMinutes: number;
  /** Newest first. */
  sessions: StatsSession[];
  mixedUnitKind: boolean;
  mixedCurrency: boolean;
  currency: string | null;
  currencyMinorUnits: number | null;
}

/**
 * The same sessions over the shared screens' filter (`report_sessions`,
 * R4.5c): every chip of the Reports screen, the dates and the options, read
 * from the hero's report rows in time order.
 */
export async function fetchReportSessions(filter: HandFilter, gapMinutes = 30): Promise<StatsSessions> {
  const empty: StatsSessions = {
    gapMinutes,
    sessions: [],
    mixedUnitKind: false,
    mixedCurrency: false,
    currency: null,
    currencyMinorUnits: null,
  };
  if (!(await currentUserId())) {
    return empty;
  }
  const payload = await rpc<Row | null>("report_sessions", {
    p_filter: { ...filter, statsVersion: STATS_VERSION },
    p_gap_minutes: gapMinutes,
  });
  return sessionsOf(payload, empty);
}

function sessionsOf(payload: Row | null, empty: StatsSessions): StatsSessions {
  if (!payload) {
    return empty;
  }
  const gapMinutes = empty.gapMinutes;
  return {
    gapMinutes: num(payload.gapMinutes) || gapMinutes,
    sessions: (Array.isArray(payload.sessions) ? (payload.sessions as Row[]) : []).map((row) => ({
      startedAt: str(row.startedAt) ?? "",
      endedAt: str(row.endedAt) ?? "",
      hands: num(row.hands),
      tables: num(row.tables),
      netBbMilli: maybeNum(row.netBbMilli),
      net: maybeNum(row.net),
    })),
    mixedUnitKind: payload.mixedUnitKind === true,
    mixedCurrency: payload.mixedCurrency === true,
    currency: str(payload.currency),
    currencyMinorUnits: maybeNum(payload.currencyMinorUnits),
  };
}

/* ---------------------------------------------------------------- notes - */

export interface PlayerNote {
  site: string;
  player: string;
  note: string;
  tags: string[];
  updatedAt?: string;
}

export function myPlayerNotes(site?: string) {
  return rpc<PlayerNote[]>("my_player_notes", site ? { p_site: site } : {});
}

/** Writes, or with an empty note and no tags clears, the caller's note on a player. */
export function setPlayerNote(site: string, player: string, note: string, tags: string[]) {
  return rpc<PlayerNote | null>("set_player_note", { p_site: site, p_player: player, p_note: note, p_tags: tags });
}
