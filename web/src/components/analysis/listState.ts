/**
 * The Analysis list's state, as it lives in the address bar.
 *
 * §6.0: "Back returns to the list with its filters kept." So the filters, the
 * sort and the page are the URL's, not a component's: the list writes them
 * with `replaceState` as they change, every hand link carries them along, and
 * the hand page's Back link rebuilds `/analysis?…` from them. A reload, a
 * bookmark and the browser's own Back all land on the same list.
 *
 * Parsing is a whitelist. Anything that is not one of these keys with one of
 * its expected values is dropped, so a hand link cannot smuggle an arbitrary
 * query into the Back link, and a stale bookmark degrades to the default list
 * rather than to an error.
 */

import { ANALYSIS_SORTS, type AnalysisFilters, type AnalysisSort } from "../../lib/db/analysis";
import { FLAG_CODES, GRADES } from "../../lib/analysis/types";

export interface AnalysisListState {
  street: string | null;
  /** A flag code, or `any` for any flag. */
  flag: string | null;
  status: string | null;
  /** A grade name (the hand's worst, exactly), or `bad`: a Mistake or a Blunder. */
  grade: string | null;
  position: string | null;
  potType: string | null;
  gameFormat: string | null;
  sort: AnalysisSort;
  page: number;
}

export const EMPTY_LIST_STATE: AnalysisListState = {
  street: null,
  flag: null,
  status: null,
  grade: null,
  position: null,
  potType: null,
  gameFormat: null,
  sort: "recent",
  page: 0,
};

export const STREET_VALUES = ["preflop", "flop", "turn", "river"] as const;
export const STATUS_VALUES = ["full", "partial", "not-analysed"] as const;
export const POT_VALUES = ["limped", "single-raised", "3bet", "4bet+", "walk", "bomb"] as const;
export const FORMAT_VALUES = ["cash", "tournament", "sng", "spin"] as const;
export const POSITION_VALUES = ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"] as const;
const FLAG_VALUES = [...FLAG_CODES, "any"] as readonly string[];
export const GRADE_VALUES = ["bad", ...GRADES] as readonly string[];

/** URL key per field: short, because these end up in shared links. */
const KEYS = {
  street: "street",
  flag: "flag",
  status: "status",
  grade: "grade",
  position: "pos",
  potType: "pot",
  gameFormat: "fmt",
  sort: "sort",
  page: "page",
} as const;

function pick(value: string | null | undefined, allowed: readonly string[]): string | null {
  return value && allowed.includes(value) ? value : null;
}

/** Reads a query (a `URLSearchParams`, or a plain record from `searchParams`). */
export function parseListState(
  source: URLSearchParams | Record<string, string | string[] | undefined>,
): AnalysisListState {
  const get = (key: string): string | null => {
    if (source instanceof URLSearchParams) return source.get(key);
    const value = source[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
  const page = Number(get(KEYS.page));
  return {
    street: pick(get(KEYS.street), STREET_VALUES),
    flag: pick(get(KEYS.flag), FLAG_VALUES),
    status: pick(get(KEYS.status), STATUS_VALUES),
    grade: pick(get(KEYS.grade), GRADE_VALUES),
    position: pick(get(KEYS.position), POSITION_VALUES),
    potType: pick(get(KEYS.potType), POT_VALUES),
    gameFormat: pick(get(KEYS.gameFormat), FORMAT_VALUES),
    sort: (pick(get(KEYS.sort), ANALYSIS_SORTS) as AnalysisSort | null) ?? "recent",
    page: Number.isInteger(page) && page > 0 && page < 10_000 ? page : 0,
  };
}

/** The query string (no `?`) for a state, defaults left out. */
export function listQuery(state: AnalysisListState): string {
  const params = new URLSearchParams();
  if (state.street) params.set(KEYS.street, state.street);
  if (state.flag) params.set(KEYS.flag, state.flag);
  if (state.status) params.set(KEYS.status, state.status);
  if (state.grade) params.set(KEYS.grade, state.grade);
  if (state.position) params.set(KEYS.position, state.position);
  if (state.potType) params.set(KEYS.potType, state.potType);
  if (state.gameFormat) params.set(KEYS.gameFormat, state.gameFormat);
  if (state.sort !== "recent") params.set(KEYS.sort, state.sort);
  if (state.page > 0) params.set(KEYS.page, String(state.page));
  return params.toString();
}

/** What the overview and the breakdown are about: the scope, not the list's own filters. */
export function scopeFilters(state: AnalysisListState): AnalysisFilters {
  const filters: AnalysisFilters = {};
  if (state.gameFormat) filters.gameFormat = state.gameFormat;
  if (state.position) filters.position = state.position;
  if (state.potType) filters.potType = state.potType;
  return filters;
}

/** What the list is about: the scope, narrowed by street, flag, grade and coverage. */
export function listFilters(state: AnalysisListState): AnalysisFilters {
  const filters = scopeFilters(state);
  if (state.street) filters.street = state.street;
  if (state.status) filters.status = state.status;
  if (state.grade === "bad") filters.minGrade = "mistake";
  else if (state.grade) filters.grade = state.grade;
  if (state.flag === "any") filters.flagged = true;
  else if (state.flag) filters.flag = state.flag;
  return filters;
}
