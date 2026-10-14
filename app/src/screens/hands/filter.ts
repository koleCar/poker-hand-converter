/**
 * The Hands screen's filter as the screen keeps and saves it: the store's
 * `HandFilter` groups, with the date as a preset ("last 7 days" stays
 * relative when a saved filter is applied again next week) or a custom range
 * of local days. `toQuery` turns it into what the store reads, with the date
 * as UTC instants.
 */
import type { HandFilter } from "../../lib/ipc";

export type DatePreset = "today" | "week" | "month" | "year" | "custom";

export const DATE_PRESETS: DatePreset[] = ["today", "week", "month", "year", "custom"];

/** The groups with a list of values. */
export type ListGroup =
  | "sites"
  | "formats"
  | "variants"
  | "limits"
  | "sizes"
  | "stakes"
  | "positions"
  | "potTypes"
  | "results"
  | "stacks"
  | "tags";

export interface FilterState {
  sites: string[];
  formats: string[];
  variants: string[];
  limits: string[];
  sizes: string[];
  stakes: string[];
  positions: string[];
  potTypes: string[];
  results: string[];
  stacks: string[];
  tags: string[];
  allIn: boolean | null;
  hasNote: boolean | null;
  date: DatePreset | null;
  /** A custom range: local days, `YYYY-MM-DD`, both inclusive. */
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_FILTER: FilterState = {
  sites: [],
  formats: [],
  variants: [],
  limits: [],
  sizes: [],
  stakes: [],
  positions: [],
  potTypes: [],
  results: [],
  stacks: [],
  tags: [],
  allIn: null,
  hasNote: null,
  date: null,
  dateFrom: "",
  dateTo: "",
};

/** Seats in table order, as the web's filter lists them. */
export const POSITION_ORDER = ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
export const POT_TYPE_ORDER = ["walk", "limped", "single-raised", "3bet", "4bet+", "bomb"];
export const RESULT_ORDER = ["won", "lost", "even"];
export const STACK_ORDER = ["0-40", "40-80", "80-120", "120+"];
export const FORMAT_ORDER = ["cash", "tournament", "sng", "spin"];
export const LIMIT_ORDER = ["nl", "pl", "fl"];
export const SIZE_ORDER = ["hu", "6max", "full"];

/** How many groups are set. */
export function activeGroups(filter: FilterState): number {
  const lists: ListGroup[] = [
    "sites",
    "formats",
    "variants",
    "limits",
    "sizes",
    "stakes",
    "positions",
    "potTypes",
    "results",
    "stacks",
    "tags",
  ];
  return (
    lists.filter((group) => filter[group].length > 0).length +
    (filter.allIn === null ? 0 : 1) +
    (filter.hasNote === null ? 0 : 1) +
    (filter.date === null ? 0 : 1)
  );
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** A local `YYYY-MM-DD` as the instant its day starts. */
function localDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The date range as UTC instants (from inclusive, to exclusive). */
export function dateRange(filter: FilterState, now: Date): { from: string | null; to: string | null } {
  const today = startOfLocalDay(now);
  switch (filter.date) {
    case null:
      return { from: null, to: null };
    case "today":
      return { from: today.toISOString(), to: null };
    case "week":
      return { from: addDays(today, -6).toISOString(), to: null };
    case "month":
      return { from: addDays(today, -29).toISOString(), to: null };
    case "year":
      return { from: addDays(today, -364).toISOString(), to: null };
    case "custom": {
      const from = localDay(filter.dateFrom);
      const to = localDay(filter.dateTo);
      return {
        from: from ? from.toISOString() : null,
        to: to ? addDays(to, 1).toISOString() : null,
      };
    }
  }
}

/** What the store reads. */
export function toQuery(filter: FilterState, now: Date = new Date()): HandFilter {
  const { from, to } = dateRange(filter, now);
  return {
    sites: filter.sites,
    formats: filter.formats,
    variants: filter.variants,
    limits: filter.limits,
    sizes: filter.sizes,
    stakes: filter.stakes,
    positions: filter.positions,
    potTypes: filter.potTypes,
    results: filter.results,
    stacks: filter.stacks,
    tags: filter.tags,
    allIn: filter.allIn,
    hasNote: filter.hasNote,
    from,
    to,
  };
}

/** A saved filter read back: whatever it lacks is "any", whatever is not a filter is dropped. */
export function fromSaved(json: string): FilterState | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const saved = value as Record<string, unknown>;
  const list = (key: ListGroup): string[] => {
    const items = saved[key];
    return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  };
  const flag = (key: "allIn" | "hasNote"): boolean | null => {
    const item = saved[key];
    return typeof item === "boolean" ? item : null;
  };
  const date = saved.date;
  const text = (key: "dateFrom" | "dateTo"): string => {
    const item = saved[key];
    return typeof item === "string" ? item : "";
  };
  return {
    sites: list("sites"),
    formats: list("formats"),
    variants: list("variants"),
    limits: list("limits"),
    sizes: list("sizes"),
    stakes: list("stakes"),
    positions: list("positions"),
    potTypes: list("potTypes"),
    results: list("results"),
    stacks: list("stacks"),
    tags: list("tags"),
    allIn: flag("allIn"),
    hasNote: flag("hasNote"),
    date: typeof date === "string" && (DATE_PRESETS as string[]).includes(date) ? (date as DatePreset) : null,
    dateFrom: text("dateFrom"),
    dateTo: text("dateTo"),
  };
}

/** The filter as saved: the screen's state (the store checks it parses as a filter). */
export function toSaved(filter: FilterState): string {
  return JSON.stringify(filter);
}

/** `values` in `order` first, the others after, alphabetically. */
export function ordered<T extends { value: string }>(values: T[], order: string[]): T[] {
  const rank = (value: string) => {
    const index = order.indexOf(value);
    return index < 0 ? order.length : index;
  };
  return [...values].sort((a, b) => rank(a.value) - rank(b.value) || a.value.localeCompare(b.value));
}
