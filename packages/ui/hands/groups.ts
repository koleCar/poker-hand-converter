/**
 * The filter groups the Hands and Reports rows are made of, as data: which
 * there are, which a source offers (`handGroups`, `REPORT_GROUPS`), how each
 * one reads its values, says what it is set to and clears; where each one
 * lives in the filter builder (its pane); and the quick filters, one click
 * each over the same state.
 *
 * The row (`FilterBar.tsx`), the "+ Add filter" menu (`AddFilter.tsx`), the
 * builder (`FilterBuilder.tsx`) and a group's editor (`GroupEditor.tsx`) all
 * read it, so a group is described once.
 */
import { useMemo } from "react";

import { useUiStrings } from "../i18n";
import {
  ANONYMIZATION_ORDER,
  EMPTY_FILTER,
  FORMAT_ORDER,
  LIMIT_ORDER,
  POSITION_ORDER,
  POT_TYPE_ORDER,
  RESULT_ORDER,
  SIZE_ORDER,
  STACK_ORDER,
  isInstant,
  PREFLOP_DID_ORDER,
  PREFLOP_FACED_ORDER,
  PREFLOP_ROLE_ORDER,
  STREETS_ORDER,
  FLOP_LINE_ORDER,
  TURN_LINE_ORDER,
  RIVER_LINE_ORDER,
  FLOP_SUITS_ORDER,
  FLOP_PAIRING_ORDER,
  FLOP_HIGH_ORDER,
  FLOP_CONNECT_ORDER,
  PLAYERS_ORDER,
  CONDITIONS_ORDER,
  WEEKDAYS_ORDER,
  DAY_PARTS_ORDER,
  LAST_HANDS_ORDER,
  GRADES_ORDER,
  BET_SIZE_ORDER,
  MADE_ORDER,
  KICKER_ORDER,
  DRAWS_ORDER,
  POSITION_FLOP_ORDER,
  PLAYERS_FLOP_ORDER,
  VS_TYPE_ORDER,
  LEVELS_ORDER,
  ordered,
  type FilterState,
  type ListGroup,
} from "./filter";
import { stakeLabel } from "./format";
import { isWholeKind, kindOf, kindOfFormat, withFormats, withKind } from "./gameKind";
import type { FacetCount, HandFacets, HandSort, MoreFilter } from "./model";

export type GroupId =
  | "date"
  | "site"
  | "format"
  | "variant"
  | "limit"
  | "size"
  | "stakes"
  | "position"
  | "potType"
  | "result"
  | "stack"
  | "allIn"
  | "notes"
  | "tags"
  | "heroHand"
  | "board"
  | "playerName"
  | "tableName"
  | "minPot"
  | "showdown"
  | "showdownPositions"
  | "winnerPositions"
  | "anonymization"
  | "sort"
  | "preflopDid"
  | "preflopFaced"
  | "preflopRole"
  | "streets"
  | "flopLine"
  | "turnLine"
  | "riverLine"
  | "flopSuits"
  | "flopPairing"
  | "flopHigh"
  | "flopConnect"
  | "players"
  | "conditions"
  | "weekdays"
  | "dayParts"
  | "lastHands"
  | "grades"
  | "heroStack"
  | "netRange"
  | "evLoss"
  | "knownCards"
  | "flopSize"
  | "turnSize"
  | "riverSize"
  | "flopMade"
  | "turnMade"
  | "riverMade"
  | "kicker"
  | "flopDraws"
  | "turnDraws"
  | "vsPosition"
  | "positionFlop"
  | "playersFlop"
  | "vsType"
  | "levels"
  | "openSize"
  | "vsVpip"
  | "buyIn"
  | "bounty";

/** The groups whose values are a list in the filter. */
export const LIST_GROUPS: Partial<Record<GroupId, ListGroup>> = {
  site: "sites",
  format: "formats",
  variant: "variants",
  limit: "limits",
  size: "sizes",
  stakes: "stakes",
  position: "positions",
  potType: "potTypes",
  result: "results",
  stack: "stacks",
  tags: "tags",
  showdownPositions: "showdownPositions",
  winnerPositions: "winnerPositions",
  anonymization: "anonymizations",
  preflopDid: "preflopDid",
  preflopFaced: "preflopFaced",
  preflopRole: "preflopRole",
  streets: "streets",
  flopLine: "flopLine",
  turnLine: "turnLine",
  riverLine: "riverLine",
  flopSuits: "flopSuits",
  flopPairing: "flopPairing",
  flopHigh: "flopHigh",
  flopConnect: "flopConnect",
  players: "players",
  conditions: "conditions",
  weekdays: "weekdays",
  dayParts: "dayParts",
  lastHands: "lastHands",
  grades: "grades",
  flopSize: "flopSize",
  turnSize: "turnSize",
  riverSize: "riverSize",
  flopMade: "flopMade",
  turnMade: "turnMade",
  riverMade: "riverMade",
  kicker: "kicker",
  flopDraws: "flopDraws",
  turnDraws: "turnDraws",
  vsPosition: "vsPosition",
  positionFlop: "positionFlop",
  playersFlop: "playersFlop",
  vsType: "vsType",
  levels: "levels",
};

/** The yes/no groups and the field each one sets. */
export const FLAG_GROUPS: Partial<Record<GroupId, "allIn" | "hasNote" | "showdown" | "knownCards" | "bounty">> = {
  allIn: "allIn",
  notes: "hasNote",
  showdown: "showdown",
  knownCards: "knownCards",
  bounty: "bounty",
};

/** The typed groups and the field each one sets. */
export const TEXT_GROUPS: Partial<
  Record<
    GroupId,
    "board" | "playerName" | "tableName" | "minPot" | "heroStack" | "netRange" | "evLoss" | "openSize" | "vsVpip" | "buyIn"
  >
> = {
  board: "board",
  playerName: "playerName",
  tableName: "tableName",
  minPot: "minPot",
  heroStack: "heroStack",
  netRange: "netRange",
  evLoss: "evLoss",
  openSize: "openSize",
  vsVpip: "vsVpip",
  buyIn: "buyIn",
};

/**
 * The filter builder's groups (V1, 2026-11-05), offered where the source
 * reads them (`HandsSource.features.builder`: the desktop store).
 */
export const BUILDER_GROUPS: GroupId[] = [
  "preflopDid",
  "preflopFaced",
  "preflopRole",
  "streets",
  "flopLine",
  "turnLine",
  "riverLine",
  "flopSuits",
  "flopPairing",
  "flopHigh",
  "flopConnect",
  "players",
  "conditions",
  "weekdays",
  "dayParts",
  "lastHands",
  "grades",
  "heroStack",
  "netRange",
  "evLoss",
  "knownCards",
  "flopSize",
  "turnSize",
  "riverSize",
  "flopMade",
  "turnMade",
  "riverMade",
  "kicker",
  "flopDraws",
  "turnDraws",
  "vsPosition",
  "positionFlop",
  "playersFlop",
  "vsType",
  "levels",
  "openSize",
  "vsVpip",
  "buyIn",
  "bounty",
];

/** Groups a source offers or not (`HandsSource.features.more`). */
const MORE_GROUPS: Record<MoreFilter, GroupId> = {
  tableName: "tableName",
  minPot: "minPot",
  showdownPositions: "showdownPositions",
  winnerPositions: "winnerPositions",
  anonymization: "anonymization",
};

/** The Hands row's common groups, in the order a player narrows by. */
export const HAND_GROUPS: GroupId[] = [
  "date",
  "site",
  "stakes",
  "position",
  "potType",
  "result",
  "stack",
  "variant",
  "limit",
  "size",
  "tags",
  "notes",
];

/**
 * The Hands groups for a source: the common ones, tags and notes where it
 * keeps them, the searches and showdown where it can search, the library's
 * other filters where it has them, the order where it can sort (first).
 */
export function handGroups(features: {
  annotations: boolean;
  search: boolean;
  sorts: HandSort[];
  more: MoreFilter[];
  builder?: boolean;
}): GroupId[] {
  const groups = HAND_GROUPS.filter((group) => features.annotations || (group !== "tags" && group !== "notes"));
  if (features.search) {
    groups.push("heroHand", "board", "playerName", "showdown");
  }
  // (2026-11-05, the owner) Who won the hand is not a filter any more; the
  // order is the list's column headers, not a group of the row.
  for (const more of features.more) {
    if (more !== "winnerPositions") groups.push(MORE_GROUPS[more]);
  }
  if (features.builder) groups.push(...BUILDER_GROUPS);
  return groups;
}

/**
 * Reports' groups (R2.7b): what `hero_totals` sums by - the dates, the
 * segment's dimensions and the hero's position. A pot type or a stack depth
 * is a breakdown there, not a filter.
 */
export const REPORT_GROUPS: GroupId[] = ["date", "site", "stakes", "position", "variant", "limit", "size"];

/* ------------------------------------------------------------ the builder */

export type PaneId =
  | "quick"
  | "positions"
  | "preflop"
  | "line"
  | "sizing"
  | "hand"
  | "strength"
  | "board"
  | "players"
  | "stacks"
  | "game"
  | "date"
  | "result"
  | "tournament"
  | "marks";

export type SectionId = "situation" | "cards" | "players" | "context";

/**
 * The builder's left rail (V1, the owner's pick of 2026-11-05): sections of
 * panes, each pane its groups. A pane whose groups the source does not
 * offer is not shown (the web library has no builder groups).
 */
export const PANES: { section: SectionId; panes: { id: PaneId; groups: GroupId[] }[] }[] = [
  {
    section: "situation",
    panes: [
      { id: "quick", groups: [] },
      { id: "positions", groups: ["position", "showdownPositions"] },
      { id: "preflop", groups: ["potType", "preflopDid", "preflopFaced", "preflopRole"] },
      { id: "line", groups: ["streets", "flopLine", "turnLine", "riverLine", "showdown"] },
      { id: "sizing", groups: ["openSize", "flopSize", "turnSize", "riverSize"] },
    ],
  },
  {
    section: "cards",
    panes: [
      { id: "hand", groups: ["heroHand"] },
      { id: "strength", groups: ["flopMade", "turnMade", "riverMade", "kicker", "flopDraws", "turnDraws"] },
      { id: "board", groups: ["board", "flopSuits", "flopPairing", "flopHigh", "flopConnect"] },
    ],
  },
  {
    section: "players",
    panes: [
      {
        id: "players",
        groups: [
          "vsPosition",
          "positionFlop",
          "playersFlop",
          "vsType",
          "vsVpip",
          "playerName",
          "knownCards",
          "players",
          "tableName",
          "anonymization",
        ],
      },
      { id: "stacks", groups: ["stack", "heroStack", "conditions"] },
    ],
  },
  {
    section: "context",
    panes: [
      { id: "game", groups: ["site", "stakes", "variant", "limit", "size"] },
      { id: "date", groups: ["date", "lastHands", "weekdays", "dayParts"] },
      { id: "result", groups: ["result", "netRange", "minPot", "grades", "evLoss"] },
      { id: "tournament", groups: ["buyIn", "bounty", "levels"] },
      { id: "marks", groups: ["tags", "notes"] },
    ],
  },
];

/** The pane a group is edited in. */
export function paneOf(group: GroupId): PaneId {
  for (const section of PANES) {
    for (const pane of section.panes) {
      if (pane.groups.includes(group)) return pane.id;
    }
  }
  return "quick";
}

/* --------------------------------------------------------- reading a group */

/** Is the group set (the order is never "set": it is not a filter)? */
export function isSet(group: GroupId, filter: FilterState): boolean {
  const list = LIST_GROUPS[group];
  if (list) return filter[list].length > 0;
  const flag = FLAG_GROUPS[group];
  if (flag) return filter[flag] !== null;
  const text = TEXT_GROUPS[group];
  if (text) return filter[text].trim() !== "";
  if (group === "date") return filter.date !== null;
  if (group === "heroHand") return filter.heroCards.trim() !== "" || filter.heroRange.length > 0;
  return false;
}

/**
 * The filter with the group back to "any". The Game group's "any" is the
 * whole of the kind the Cash / Tournaments toggle shows, never both kinds.
 */
export function clearGroup(group: GroupId, filter: FilterState, facets: HandFacets | null = null): FilterState {
  if (group === "format") return withFormats(filter, [], facets);
  const list = LIST_GROUPS[group];
  if (list) return { ...filter, [list]: [] };
  const flag = FLAG_GROUPS[group];
  if (flag) return { ...filter, [flag]: null };
  const text = TEXT_GROUPS[group];
  if (text) return { ...filter, [text]: "" };
  if (group === "date") return { ...filter, date: null, dateFrom: "", dateTo: "" };
  if (group === "heroHand") return { ...filter, heroCards: "", heroRange: [] };
  return filter;
}

/**
 * The groups of the row that are set and shown as chips. The Game group is
 * not, while it only holds the kind the Cash / Tournaments toggle set.
 */
export function shownSet(groups: readonly GroupId[], filter: FilterState, facets: HandFacets | null): GroupId[] {
  const wholeKind = isWholeKind(filter, facets);
  return groups.filter((group) => group !== "sort" && isSet(group, filter) && !(group === "format" && wholeKind));
}

/** Every filter off, the order kept, and the kind the toggle shows (all of it). */
export function clearAll(filter: FilterState, facets: HandFacets | null = null): FilterState {
  const cleared: FilterState = { ...EMPTY_FILTER, sort: filter.sort };
  const kind = kindOf(filter.formats);
  return kind === null ? cleared : withKind(cleared, kind, facets);
}

/**
 * The values a list group has switched on, as its editor shows them: the
 * whole of the toggle's kind reads as none (the Game group's "any").
 */
export function selectedOf(group: GroupId, filter: FilterState, facets: HandFacets | null): string[] {
  const list = LIST_GROUPS[group];
  if (!list) return [];
  return group === "format" && isWholeKind(filter, facets) ? [] : filter[list];
}

/** A list group set to these values; the Game group stays within one kind. */
export function withValues(group: GroupId, filter: FilterState, next: string[], facets: HandFacets | null): FilterState {
  const list = LIST_GROUPS[group];
  if (!list) return filter;
  return group === "format" ? withFormats(filter, next, facets) : { ...filter, [list]: next };
}

export interface GroupOption {
  value: string;
  label: string;
}

/** The combos of a starting-hand class: a pair 6, suited 4, offsuit 12. */
export function combosOf(handClass: string): number {
  return handClass.length === 2 ? 6 : handClass.endsWith("s") ? 4 : 12;
}

/** The share of all 1,326 starting hands, one decimal. */
export function rangePercent(range: readonly string[]): number {
  const combos = range.reduce((sum, value) => sum + combosOf(value), 0);
  return Math.round((combos / 1326) * 1000) / 10;
}

/**
 * The words a surface's rows read: each group's name, its options' labels
 * and what a set group says. One hook, so the row, the menu and the builder
 * say the same thing.
 */
/**
 * A custom range's end as its chip says it: a local day as typed, an exact
 * instant (a session's) as a short date and time - the time alone when it
 * ends on the day it began.
 */
function customEnd(value: string, locale: string, start?: string): string {
  if (!isInstant(value)) return value;
  const at = new Date(value);
  const sameDay = start !== undefined && isInstant(start) && new Date(start).toDateString() === at.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
}

export function useGroupWords() {
  const strings = useUiStrings();
  const t = strings.hands.filters;
  const variants = strings.replayer.facts.variants as Record<string, string>;
  return useMemo(() => {
    const maps: Partial<Record<GroupId, Record<string, string>>> = {
      format: t.formats,
      limit: t.limits,
      size: t.sizes,
      potType: t.potTypes,
      result: t.results,
      stack: t.stacks,
      variant: variants,
      anonymization: t.anonymizations,
      preflopDid: t.builder.preflopDid,
      preflopFaced: t.builder.preflopFaced,
      preflopRole: t.builder.preflopRole,
      streets: t.builder.streets,
      flopLine: t.builder.flopLine,
      turnLine: t.builder.turnLine,
      riverLine: t.builder.riverLine,
      flopSuits: t.builder.flopSuits,
      flopPairing: t.builder.flopPairing,
      flopHigh: t.builder.flopHigh,
      flopConnect: t.builder.flopConnect,
      players: t.builder.players,
      conditions: t.builder.conditions,
      weekdays: t.builder.weekdays,
      dayParts: t.builder.dayParts,
      lastHands: t.builder.lastHands,
      grades: t.builder.grades,
      flopSize: t.builder.sizes,
      turnSize: t.builder.sizes,
      riverSize: t.builder.sizes,
      flopMade: t.builder.made,
      turnMade: t.builder.made,
      riverMade: t.builder.made,
      kicker: t.builder.kicker,
      flopDraws: t.builder.draws,
      turnDraws: t.builder.draws,
      positionFlop: t.builder.positionFlop,
      playersFlop: t.builder.playersFlop,
      vsType: t.builder.vsType,
      levels: t.builder.levels,
    };
    const orders: Partial<Record<GroupId, string[]>> = {
      position: POSITION_ORDER,
      potType: POT_TYPE_ORDER,
      result: RESULT_ORDER,
      stack: STACK_ORDER,
      format: FORMAT_ORDER,
      limit: LIMIT_ORDER,
      size: SIZE_ORDER,
      showdownPositions: POSITION_ORDER,
      winnerPositions: POSITION_ORDER,
      anonymization: ANONYMIZATION_ORDER,
      ...BUILDER_ORDERS,
    };
    /** The values a list group offers: what the hands have, and what is chosen. No counts. */
    const options = (group: GroupId, filter: FilterState, facets: HandFacets | null): GroupOption[] => {
      const list = LIST_GROUPS[group];
      if (!list) return [];
      let values: (FacetCount & { label?: string })[];
      switch (group) {
        case "site":
          values = (facets?.sites ?? []).map((f) => ({ ...f, label: f.name }));
          break;
        case "stakes":
          values = (facets?.stakes ?? []).map((f) => ({ ...f, label: stakeLabel(f) ?? t.chips }));
          break;
        case "tags":
          values = facets?.tags ?? [];
          break;
        case "anonymization":
          values = facets?.anonymizations ?? ANONYMIZATION_ORDER.map((value) => ({ value, count: 1 }));
          break;
        case "showdownPositions":
        case "winnerPositions":
          values = POSITION_ORDER.map((value) => ({ value, count: 1 }));
          break;
        case "preflopDid":
        case "preflopFaced":
        case "preflopRole":
        case "streets":
        case "flopLine":
        case "turnLine":
        case "riverLine":
        case "flopSuits":
        case "flopPairing":
        case "flopHigh":
        case "flopConnect":
        case "players":
        case "conditions":
        case "weekdays":
        case "dayParts":
        case "lastHands":
        case "grades":
        case "flopSize":
        case "turnSize":
        case "riverSize":
        case "flopMade":
        case "turnMade":
        case "riverMade":
        case "kicker":
        case "flopDraws":
        case "turnDraws":
        case "vsPosition":
        case "positionFlop":
        case "playersFlop":
        case "vsType":
        case "levels":
          values = (BUILDER_ORDERS[group] ?? []).map((value) => ({ value, count: 1 }));
          break;
        case "position": {
          const seen = (facets?.positions ?? []).filter((f) => f.value !== "" && f.count > 0);
          values = seen.length > 0 ? seen : DEFAULT_SEATS.map((value) => ({ value, count: 1 }));
          break;
        }
        default: {
          const own = facets
            ? facets[list as "formats" | "variants" | "limits" | "sizes" | "potTypes" | "results" | "stacks"]
            : null;
          const fallback = orders[group] ?? [];
          values = own ? own.filter((f) => f.value !== "") : fallback.map((value) => ({ value, count: 1 }));
        }
      }
      // A value with no hands left is not offered; one that is chosen always is.
      values = values.filter((f) => f.count > 0 || group === "tags");
      // The Game group narrows within the kind the toggle shows: the other
      // kind's formats are not offered (cash and tournaments never together).
      const kind = group === "format" ? kindOf(filter.formats) : null;
      if (kind !== null) values = values.filter((f) => kindOfFormat(f.value) === kind);
      for (const value of filter[list]) {
        if (!values.some((v) => v.value === value)) values = values.concat({ value, count: 0 });
      }
      const sorted = group === "stakes" ? values : ordered(values, orders[group] ?? []);
      return sorted.map((v) => ({ value: v.value, label: maps[group]?.[v.value] ?? v.label ?? v.value }));
    };

    const labelOf = (group: GroupId, value: string, facets: HandFacets | null): string => {
      if (group === "site") return facets?.sites.find((f) => f.value === value)?.name ?? value;
      if (group === "stakes") {
        const facet = facets?.stakes.find((f) => f.value === value);
        return facet ? (stakeLabel(facet) ?? t.chips) : value;
      }
      return maps[group]?.[value] ?? value;
    };

    const joined = (labels: string[]): string =>
      labels.length <= 2 ? labels.join(", ") : t.more(labels.slice(0, 2).join(", "), labels.length - 2);

    /** What a set group says on its chip ("BTN, CO", "Last 7 days"); null when it is not set. */
    const summary = (group: GroupId, filter: FilterState, facets: HandFacets | null): string | null => {
      if (!isSet(group, filter)) return null;
      const list = LIST_GROUPS[group];
      if (list) {
        const order = orders[group];
        const values = order ? ordered(filter[list].map((value) => ({ value })), order).map((v) => v.value) : filter[list];
        return joined(values.map((value) => labelOf(group, value, facets)));
      }
      switch (group) {
        case "date":
          return filter.date === "custom"
            ? `${customEnd(filter.dateFrom, strings.intlLocale) || "…"} – ${customEnd(filter.dateTo, strings.intlLocale, filter.dateFrom) || "…"}`
            : t.dates[filter.date ?? "custom"];
        case "allIn":
          return filter.allIn ? t.allIn.yes : t.allIn.no;
        case "notes":
          return filter.hasNote ? t.notes.yes : t.notes.no;
        case "showdown":
          return filter.showdown ? t.showdownValues.yes : t.showdownValues.no;
        case "knownCards":
          return filter.knownCards ? t.builder.knownCardsValues.yes : t.builder.knownCardsValues.no;
        case "heroStack":
        case "netRange":
          return `${filter[group].trim()} bb`;
        case "evLoss":
          return `≥ ${filter.evLoss.trim()} bb`;
        case "openSize":
          return `${filter.openSize.trim()} bb`;
        case "vsVpip":
          return `VPIP ${filter.vsVpip.trim()} %`;
        case "bounty":
          return filter.bounty ? t.builder.bountyValues.yes : t.builder.bountyValues.no;
        case "minPot":
          return `≥ ${filter.minPot.trim()}`;
        case "heroHand": {
          const parts: string[] = [];
          if (filter.heroRange.length > 0) {
            parts.push(
              filter.heroRange.length <= 3
                ? filter.heroRange.join(", ")
                : t.range.chip(rangePercent(filter.heroRange).toLocaleString(strings.intlLocale)),
            );
          }
          if (filter.heroCards.trim()) parts.push(filter.heroCards.trim());
          return parts.join(" · ");
        }
        default: {
          const text = TEXT_GROUPS[group];
          return text ? filter[text].trim() : null;
        }
      }
    };

    return { name: (group: GroupId) => t.groups[group], options, summary };
  }, [t, variants, strings.intlLocale]);
}

/** The builder's list groups' values, in their order. */
const BUILDER_ORDERS: Partial<Record<GroupId, string[]>> = {
  preflopDid: PREFLOP_DID_ORDER,
  preflopFaced: PREFLOP_FACED_ORDER,
  preflopRole: PREFLOP_ROLE_ORDER,
  streets: STREETS_ORDER,
  flopLine: FLOP_LINE_ORDER,
  turnLine: TURN_LINE_ORDER,
  riverLine: RIVER_LINE_ORDER,
  flopSuits: FLOP_SUITS_ORDER,
  flopPairing: FLOP_PAIRING_ORDER,
  flopHigh: FLOP_HIGH_ORDER,
  flopConnect: FLOP_CONNECT_ORDER,
  players: PLAYERS_ORDER,
  conditions: CONDITIONS_ORDER,
  weekdays: WEEKDAYS_ORDER,
  dayParts: DAY_PARTS_ORDER,
  lastHands: LAST_HANDS_ORDER,
  grades: GRADES_ORDER,
  flopSize: BET_SIZE_ORDER,
  turnSize: BET_SIZE_ORDER,
  riverSize: BET_SIZE_ORDER,
  flopMade: MADE_ORDER,
  turnMade: MADE_ORDER,
  riverMade: MADE_ORDER,
  kicker: KICKER_ORDER,
  flopDraws: DRAWS_ORDER,
  turnDraws: DRAWS_ORDER,
  vsPosition: POSITION_ORDER,
  positionFlop: POSITION_FLOP_ORDER,
  playersFlop: PLAYERS_FLOP_ORDER,
  vsType: VS_TYPE_ORDER,
  levels: LEVELS_ORDER,
};

/** The seats a 6-max table has: offered before any hand says otherwise. */
const DEFAULT_SEATS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

/* ------------------------------------------------------------ quick filters */

export type QuickId = "week" | "threeBet" | "showdown" | "won" | "lost" | "noted";

export interface QuickFilter {
  id: QuickId;
  /** The group it sets: offered only where the row has it. */
  group: GroupId;
  on: (filter: FilterState) => boolean;
  toggle: (filter: FilterState) => FilterState;
}

/** A list group's values switched on together, or off together. */
function listQuick(id: QuickId, group: GroupId, list: ListGroup, values: string[]): QuickFilter {
  return {
    id,
    group,
    on: (filter) => values.every((value) => filter[list].includes(value)),
    toggle: (filter) => {
      const has = values.every((value) => filter[list].includes(value));
      const rest = filter[list].filter((value) => !values.includes(value));
      return { ...filter, [list]: has ? rest : [...rest, ...values] };
    },
  };
}

function flagQuick(id: QuickId, group: GroupId, flag: "allIn" | "hasNote" | "showdown"): QuickFilter {
  return {
    id,
    group,
    on: (filter) => filter[flag] === true,
    toggle: (filter) => ({ ...filter, [flag]: filter[flag] === true ? null : true }),
  };
}

/** The quick row, in its order; each shown where its group is. */
export const QUICK_FILTERS: QuickFilter[] = [
  {
    id: "week",
    group: "date",
    on: (filter) => filter.date === "week",
    toggle: (filter) => ({ ...filter, date: filter.date === "week" ? null : "week", dateFrom: "", dateTo: "" }),
  },
  listQuick("threeBet", "potType", "potTypes", ["3bet", "4bet+"]),
  flagQuick("showdown", "showdown", "showdown"),
  listQuick("won", "result", "results", ["won"]),
  listQuick("lost", "result", "results", ["lost"]),
  flagQuick("noted", "notes", "hasNote"),
];

/** The quick filters a row of these groups offers. */
export function quickFor(groups: readonly GroupId[]): QuickFilter[] {
  return QUICK_FILTERS.filter((quick) => groups.includes(quick.group));
}
