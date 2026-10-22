/**
 * The Hands screen's filter as the screen keeps and saves it: the
 * `HandFilter` groups, with the date as a preset ("last 7 days" stays
 * relative when a saved filter is applied again next week) or a custom range
 * of local days. `toQuery` turns it into what a source reads, with the date
 * as UTC instants. A player (R2.7c, "hands with this player" from the app's
 * Players screen) narrows it to an opponent's hands; the searches and the
 * order (R4.5b) are the web library's, where the source has them.
 *
 * Moved from the desktop app (`app/src/screens/hands/filter.ts`, which now
 * re-exports this and keeps the app's hand-offs between screens).
 */
import { extractCards, resolveHeroQuery } from "../model/cards";
import type { HandFilter, HandSort, PlayerRef } from "./model";

export type DatePreset = "today" | "week" | "month" | "year" | "custom";

export const DATE_PRESETS: DatePreset[] = ["today", "week", "month", "year", "custom"];

export const SORTS: HandSort[] = ["newest", "oldest", "pot", "won", "lost"];

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

const LIST_GROUPS: ListGroup[] = [
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
  /** Only hands this opponent was dealt into (R2.7c). */
  player: PlayerRef | null;
  /** The searches, as typed: hero cards or a class ("AKs", "TT"), board cards, a name at the table. */
  heroCards: string;
  board: string;
  playerName: string;
  showdown: boolean | null;
  sort: HandSort;
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
  player: null,
  heroCards: "",
  board: "",
  playerName: "",
  showdown: null,
  sort: "newest",
};

/** Seats in table order, as the web's filter lists them. */
export const POSITION_ORDER = ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
export const POT_TYPE_ORDER = ["walk", "limped", "single-raised", "3bet", "4bet+", "bomb"];
export const RESULT_ORDER = ["won", "lost", "even"];
export const STACK_ORDER = ["0-40", "40-80", "80-120", "120+"];
export const FORMAT_ORDER = ["cash", "tournament", "sng", "spin"];
export const LIMIT_ORDER = ["nl", "pl", "fl"];
export const SIZE_ORDER = ["hu", "6max", "full"];

/** How many of the searches are set. */
export function activeSearches(filter: FilterState): number {
  return (
    (filter.heroCards.trim() ? 1 : 0) +
    (filter.board.trim() ? 1 : 0) +
    (filter.playerName.trim() ? 1 : 0) +
    (filter.showdown === null ? 0 : 1)
  );
}

/** How many groups are set (the order is not a filter). */
export function activeGroups(filter: FilterState): number {
  return (
    LIST_GROUPS.filter((group) => filter[group].length > 0).length +
    (filter.allIn === null ? 0 : 1) +
    (filter.hasNote === null ? 0 : 1) +
    (filter.date === null ? 0 : 1) +
    (filter.player === null ? 0 : 1) +
    activeSearches(filter)
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

/** What a source reads. The searches and the order go only where set. */
export function toQuery(filter: FilterState, now: Date = new Date()): HandFilter {
  const { from, to } = dateRange(filter, now);
  const query: HandFilter = {
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
    player: filter.player,
  };
  const hero = resolveHeroQuery(filter.heroCards);
  if (hero.kind === "class") query.heroHandClasses = hero.values;
  if (hero.kind === "cards") query.heroCards = hero.values;
  const board = extractCards(filter.board);
  if (board.length > 0) query.board = board;
  if (filter.playerName.trim()) query.playerName = filter.playerName.trim();
  if (filter.showdown !== null) query.showdown = filter.showdown;
  if (filter.sort !== "newest") query.sort = filter.sort;
  return query;
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
  const flag = (key: "allIn" | "hasNote" | "showdown"): boolean | null => {
    const item = saved[key];
    return typeof item === "boolean" ? item : null;
  };
  const date = saved.date;
  const text = (key: "dateFrom" | "dateTo" | "heroCards" | "board" | "playerName"): string => {
    const item = saved[key];
    return typeof item === "string" ? item : "";
  };
  const player = saved.player as Record<string, unknown> | null | undefined;
  const sort = saved.sort;
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
    player:
      typeof player === "object" &&
      player !== null &&
      typeof player.site === "string" &&
      typeof player.player === "string" &&
      player.player !== ""
        ? { site: player.site, player: player.player }
        : null,
    heroCards: text("heroCards"),
    board: text("board"),
    playerName: text("playerName"),
    showdown: flag("showdown"),
    sort: typeof sort === "string" && (SORTS as string[]).includes(sort) ? (sort as HandSort) : "newest",
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
