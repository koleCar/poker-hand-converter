/**
 * The Reports filters, as they live in the address bar: date range, room,
 * stake and the hero's seat — the same keys the Analysis tab's reports take
 * (`analysis_scope`), so a link to a report is the report.
 *
 * Parsing is a whitelist, like the hands list's (`listState.ts`): anything
 * that is not one of these keys with a value of the expected shape is
 * dropped, and a stale bookmark degrades to the whole library.
 */

import type { AnalysisFilters } from "../../../lib/db/analysis";

export interface ReportsState {
  /** `YYYY-MM-DD`, inclusive. */
  from: string | null;
  /** `YYYY-MM-DD`, inclusive (the filter sends the next day's midnight). */
  to: string | null;
  room: string | null;
  /** `<currency>:<big blind in minor units>`. */
  stake: string | null;
  position: string | null;
}

export const EMPTY_REPORTS_STATE: ReportsState = { from: null, to: null, room: null, stake: null, position: null };

/** The seats the charts cover, in table order: 6-max's, and 9-max's own seats among them (A2c). */
export const REPORT_POSITIONS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"] as const;

/** The Reports screen's chart set filter (A2d), in the address bar as `set`; absent is every set. */
export const REPORT_SET_KEY = "set";
const SET_RE = /^nlhe-cash-[0-9]max-[0-9]{2,3}bb$/;

/** The `set` parameter, or null for "all sets". */
export function parseReportSet(source: URLSearchParams | Record<string, string | string[] | undefined>): string | null {
  const value = source instanceof URLSearchParams ? source.get(REPORT_SET_KEY) : source[REPORT_SET_KEY];
  const one = Array.isArray(value) ? value[0] : value;
  return one && SET_RE.test(one) ? one : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STAKE_RE = /^[A-Z]{2,8}:\d{1,12}$/;

const KEYS = { from: "from", to: "to", room: "room", stake: "stake", position: "pos" } as const;

function validDate(value: string | null): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? value : null;
}

export function parseReportsState(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): ReportsState {
  const get = (key: string): string | null => {
    if (source instanceof URLSearchParams) return source.get(key);
    const value = source[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
  const room = get(KEYS.room);
  const stake = get(KEYS.stake);
  const position = get(KEYS.position);
  return {
    from: validDate(get(KEYS.from)),
    to: validDate(get(KEYS.to)),
    room: room && ROOM_RE.test(room) ? room : null,
    stake: stake && STAKE_RE.test(stake) ? stake : null,
    position: position && (REPORT_POSITIONS as readonly string[]).includes(position) ? position : null,
  };
}

export function reportsQuery(state: ReportsState): string {
  const params = new URLSearchParams();
  if (state.from) params.set(KEYS.from, state.from);
  if (state.to) params.set(KEYS.to, state.to);
  if (state.room) params.set(KEYS.room, state.room);
  if (state.stake) params.set(KEYS.stake, state.stake);
  if (state.position) params.set(KEYS.position, state.position);
  return params.toString();
}

/** The day after a `YYYY-MM-DD`, for an inclusive "to". */
function nextDay(date: string): string {
  const time = Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  return new Date(time).toISOString().slice(0, 10);
}

/** The report filters. Dates are UTC days, the way `played_at` is stored. */
export function reportsFilters(state: ReportsState): AnalysisFilters {
  const filters: AnalysisFilters = {};
  if (state.from) filters.from = `${state.from}T00:00:00Z`;
  if (state.to) filters.to = `${nextDay(state.to)}T00:00:00Z`;
  if (state.room) filters.site = state.room;
  if (state.stake) {
    const [currency, bigBlind] = state.stake.split(":");
    filters.currency = currency;
    filters.bigBlind = Number(bigBlind);
  }
  if (state.position) filters.position = state.position;
  return filters;
}

export const stakeKey = (currency: string, bigBlind: number | null) => `${currency}:${bigBlind ?? 0}`;
