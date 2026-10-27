/**
 * The session review's address (`/analysis/session?…`, R5.1): which session
 * (`at`, any instant in it; none = the latest that has ended), the break that
 * ends a session (`gap`, minutes) and the Statistics filter's groups a link
 * from Statistics -> Sessions carries (sessions depend on the filter: a cash
 * evening split by a tournament is two cash sessions).
 *
 * Parsing is a whitelist, like the Analysis list's (`listState.ts`): a key
 * that is not one of these, or a value of the wrong shape, is dropped, so a
 * link cannot smuggle anything into the request or the Back link of a hand
 * opened from here. Dates are never carried: a session is not cut by them.
 */

import type { HandFilter } from "@rail/ui/hands/model";
import type { SessionQuery } from "@rail/ui/review/model";

/** The Sessions panel's choices; any whole number of minutes from 5 to 720 is read. */
export const DEFAULT_GAP = 30;

/** URL key per filter group (short: these end up in links). */
const GROUP_KEYS = {
  sites: "site",
  formats: "fmt",
  variants: "variant",
  limits: "limit",
  sizes: "size",
  stakes: "stake",
  positions: "pos",
} as const satisfies Record<string, string>;

type Group = keyof typeof GROUP_KEYS;
const GROUPS = Object.keys(GROUP_KEYS) as Group[];

/** A room, a format, a stake key (`USD:200`, `chips`), a seat (`UTG+1`). */
const VALUE = /^[A-Za-z0-9:+._-]{1,40}$/;
const MAX_VALUES = 20;

type Source = URLSearchParams | Record<string, string | string[] | undefined>;

function getter(source: Source): (key: string) => string | null {
  return (key) => {
    if (source instanceof URLSearchParams) return source.get(key);
    const value = source[key];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  };
}

/** An ISO instant, normalised; null for anything else. */
function instant(raw: string | null): string | null {
  if (!raw || raw.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Reads the address (a `URLSearchParams`, or the page's `searchParams`). */
export function parseSessionQuery(source: Source): SessionQuery {
  const get = getter(source);
  const gap = Number(get("gap"));
  const filter: HandFilter = {};
  for (const group of GROUPS) {
    const values = (get(GROUP_KEYS[group]) ?? "")
      .split(",")
      .filter((value) => VALUE.test(value))
      .slice(0, MAX_VALUES);
    if (values.length > 0) filter[group] = values;
  }
  return {
    at: instant(get("at")),
    gapMinutes: Number.isInteger(gap) && gap >= 5 && gap <= 720 ? gap : DEFAULT_GAP,
    filter,
  };
}

/** The query string (no `?`) for a session review, defaults left out. */
export function sessionQueryString(query: SessionQuery): string {
  const params = new URLSearchParams();
  if (query.at) params.set("at", query.at);
  if (query.gapMinutes !== DEFAULT_GAP) params.set("gap", String(query.gapMinutes));
  for (const group of GROUPS) {
    const values = (query.filter[group] ?? []).filter((value) => VALUE.test(value));
    if (values.length > 0) params.set(GROUP_KEYS[group], values.join(","));
  }
  return params.toString();
}

/** The groups of a Statistics filter a session link carries (dates and searches dropped). */
export function sessionFilterOf(filter: HandFilter): HandFilter {
  const out: HandFilter = {};
  for (const group of GROUPS) {
    const values = filter[group];
    if (values && values.length > 0) out[group] = [...values];
  }
  return out;
}

/** A hand opened from the review: its Back link returns here (`from=session` + the review's own keys). */
export function fromSessionQuery(query: SessionQuery): string {
  const rest = sessionQueryString(query);
  return rest ? `from=session&${rest}` : "from=session";
}

/** Whether a hand page was opened from the review. */
export function cameFromSession(source: Source): boolean {
  return getter(source)("from") === "session";
}
