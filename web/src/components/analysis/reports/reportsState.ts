/**
 * The Analysis tabs' filter (Reports, Leaks, Progress), as it lives in the
 * address bar: the Hands list's own filter row (2026-11-16, the owner: one
 * filter everywhere) and the kind of game. The filter travels as the saved
 * form of the shared filter (`f`, the groups that are set), so a link to a report is the
 * report; the server reads it as the Hands list does (`hands`,
 * `analysis_hand_ids`).
 *
 * Links from before keep working: `from`, `to`, `room`, `stake` and `pos`
 * become the same groups of the shared filter. Parsing is a whitelist: a
 * value of the wrong shape is dropped, and a stale bookmark degrades to the
 * whole library.
 */

import { EMPTY_FILTER, activeGroups, fromSaved, toQuery, type FilterState } from "@rail/ui/hands/filter";
import type { GameKind } from "@rail/ui/hands/gameKind";
import type { AnalysisFilters } from "../../../lib/db/analysis";
import { libraryFilter } from "../../../lib/db/handsSource";
import { KIND_KEY, parseKind } from "../analysisKind";

export interface ReportsState {
  /** The Hands list's filter row; its Game group stays empty (the kind is `kind`). */
  filter: FilterState;
  /**
   * Cash or tournaments - one kind, never both (`analysisKind.ts`). Null in
   * an address that names none: the screen decides (`useAnalysisKind`).
   */
  kind: GameKind | null;
}

export const EMPTY_REPORTS_STATE: ReportsState = { filter: EMPTY_FILTER, kind: null };

/** The seats the charts cover, in table order: 6-max's, and 9-max's own seats among them (A2c). */
export const REPORT_POSITIONS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"] as const;

/** The Reports screen's chart set filter (A2d), in the address bar as `set`; absent is every set. */
export const REPORT_SET_KEY = "set";
const SET_RE = /^nlhe-cash-([0-9]max|hu)-[0-9]{2,3}bb(-ante|-straddle)?$/;

/** The `set` parameter, or null for "all sets". */
export function parseReportSet(source: URLSearchParams | Record<string, string | string[] | undefined>): string | null {
  const value = source instanceof URLSearchParams ? source.get(REPORT_SET_KEY) : source[REPORT_SET_KEY];
  const one = Array.isArray(value) ? value[0] : value;
  return one && SET_RE.test(one) ? one : null;
}

/** The shared filter's key in the address bar. */
export const FILTER_KEY = "f";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STAKE_RE = /^[A-Z]{2,8}:\d{1,12}$/;

function validDate(value: string | null): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? value : null;
}

/** The filter of a link from before the shared row: dates, one room, one stake, one seat. */
function legacyFilter(get: (key: string) => string | null): FilterState {
  const from = validDate(get("from"));
  const to = validDate(get("to"));
  const room = get("room");
  const stake = get("stake");
  const position = get("pos");
  return {
    ...EMPTY_FILTER,
    date: from || to ? "custom" : null,
    dateFrom: from ?? "",
    dateTo: to ?? "",
    sites: room && ROOM_RE.test(room) ? [room] : [],
    stakes: stake && STAKE_RE.test(stake) ? [stake] : [],
    positions: position && (REPORT_POSITIONS as readonly string[]).includes(position) ? [position] : [],
  };
}

export function parseReportsState(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): ReportsState {
  const get = (key: string): string | null => {
    if (source instanceof URLSearchParams) return source.get(key);
    const value = source[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
  const saved = get(FILTER_KEY);
  const filter = saved ? fromSaved(saved) : null;
  return {
    // The kind is the switch's, never the Game group's.
    filter: { ...(filter ?? legacyFilter(get)), formats: [] },
    kind: parseKind(source),
  };
}

/** The saved form of the groups that are set only (`fromSaved` fills in the rest): a short address. */
function compactSaved(filter: FilterState): string {
  const empty = EMPTY_FILTER as unknown as Record<string, unknown>;
  const set = Object.entries(filter).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(empty[key]));
  return JSON.stringify(Object.fromEntries(set));
}

export function reportsQuery(state: ReportsState): string {
  const params = new URLSearchParams();
  if (activeGroups(state.filter) > 0) params.set(FILTER_KEY, compactSaved(state.filter));
  if (state.kind) params.set(KIND_KEY, state.kind);
  return params.toString();
}

/** The readers' filters: the kind, and the Hands list's filter when it sets a group. */
export function reportsFilters(state: ReportsState, now: Date = new Date()): AnalysisFilters {
  const filters: AnalysisFilters = {};
  if (state.kind) filters.gameKind = state.kind;
  if (activeGroups(state.filter) > 0) filters.hands = libraryFilter(toQuery({ ...state.filter, formats: [] }, now));
  return filters;
}

export const stakeKey = (currency: string, bigBlind: number | null) => `${currency}:${bigBlind ?? 0}`;
