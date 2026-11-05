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

export const SORTS: HandSort[] = ["newest", "oldest", "pot", "potAsc", "won", "lost", "stakes", "stakesAsc", "position", "positionDesc"];

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
  | "tags"
  | "showdownPositions"
  | "winnerPositions"
  | "anonymizations"
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
  | "levels";

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
  "showdownPositions",
  "winnerPositions",
  "anonymizations",
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
  /**
   * Starting-hand classes picked on the range grid ("AA", "AKs", "AKo"):
   * the hero held one of them. Empty, any. With a class typed into
   * `heroCards` as well, both must hold.
   */
  heroRange: string[];
  board: string;
  playerName: string;
  showdown: boolean | null;
  /** The web library's other filters, as typed or chosen (`HandsSource.features.more`). */
  tableName: string;
  /** The smallest pot in the hand's own unit, as typed ("25", "2,5"). */
  minPot: string;
  showdownPositions: string[];
  winnerPositions: string[];
  anonymizations: string[];
  sort: HandSort;
  /**
   * The filter builder's groups (V1, 2026-11-05). The hero's actions, by the
   * store's names (`hand_list::ACTS`): what hero did and faced preflop, the
   * preflop role, the streets seen, the line on each street.
   */
  preflopDid: string[];
  preflopFaced: string[];
  preflopRole: string[];
  streets: string[];
  flopLine: string[];
  turnLine: string[];
  riverLine: string[];
  /** The flop's texture: suits, pairing, highest rank, a straight possible. */
  flopSuits: string[];
  flopPairing: string[];
  flopHigh: string[];
  flopConnect: string[];
  /** Players dealt in (`2` ... `6`, `7plus`), game conditions (all of them). */
  players: string[];
  conditions: string[];
  /** Days of the week (`1` Monday ... `7` Sunday) and parts of the day, the reader's time. */
  weekdays: string[];
  dayParts: string[];
  /** The latest so many hands (`100`, `500`, ...; the largest chosen). */
  lastHands: string[];
  /** The analysis: a decision so graded, analysed and clean, not analysed. */
  grades: string[];
  /** Ranges as typed, big blinds: "80-120", "40+", "<30"; EV lost at least. */
  heroStack: string;
  netRange: string;
  evLoss: string;
  /** A villain's cards were seen (`true`), or none were. */
  knownCards: boolean | null;
  /**
   * The builder's PHF facts (schema 19): the hero's bet sizes by street
   * (`small` ... `overbet`), what the hero made and drew to by street, a top
   * pair's kicker, the opponents in the pot (their positions, the hero's
   * position on the flop, how many saw it, their type), the tournament.
   */
  flopSize: string[];
  turnSize: string[];
  riverSize: string[];
  flopMade: string[];
  turnMade: string[];
  riverMade: string[];
  kicker: string[];
  flopDraws: string[];
  turnDraws: string[];
  vsPosition: string[];
  positionFlop: string[];
  playersFlop: string[];
  vsType: string[];
  levels: string[];
  /** Ranges as typed: the open in big blinds, a villain's VPIP in percent, a buy-in in its currency. */
  openSize: string;
  vsVpip: string;
  buyIn: string;
  /** A bounty tournament (`true`), or not. */
  bounty: boolean | null;
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
  heroRange: [],
  board: "",
  playerName: "",
  showdown: null,
  tableName: "",
  minPot: "",
  showdownPositions: [],
  winnerPositions: [],
  anonymizations: [],
  sort: "newest",
  preflopDid: [],
  preflopFaced: [],
  preflopRole: [],
  streets: [],
  flopLine: [],
  turnLine: [],
  riverLine: [],
  flopSuits: [],
  flopPairing: [],
  flopHigh: [],
  flopConnect: [],
  players: [],
  conditions: [],
  weekdays: [],
  dayParts: [],
  lastHands: [],
  grades: [],
  heroStack: "",
  netRange: "",
  evLoss: "",
  knownCards: null,
  flopSize: [],
  turnSize: [],
  riverSize: [],
  flopMade: [],
  turnMade: [],
  riverMade: [],
  kicker: [],
  flopDraws: [],
  turnDraws: [],
  vsPosition: [],
  positionFlop: [],
  playersFlop: [],
  vsType: [],
  levels: [],
  openSize: "",
  vsVpip: "",
  buyIn: "",
  bounty: null,
};

/** The builder's action groups, each a group of `hand_list::ACTS` names. */
export const ACT_GROUPS = ["preflopDid", "preflopFaced", "preflopRole", "streets", "flopLine", "turnLine", "riverLine"] as const;
export const PREFLOP_DID_ORDER = ["open", "limp", "iso", "callOpen", "threeBet", "callThreeBet", "fourBet", "squeeze", "steal", "foldToThreeBet"];
export const PREFLOP_FACED_ORDER = ["facedUnopened", "facedLimp", "facedOpen", "facedThreeBet", "facedFourBet"];
export const PREFLOP_ROLE_ORDER = ["aggressor", "caller"];
export const STREETS_ORDER = ["sawFlop", "sawTurn", "sawRiver"];
export const FLOP_LINE_ORDER = ["cbetFlop", "facingCbetFlop", "raiseCbetFlop", "checkRaiseFlop", "donkFlop"];
export const TURN_LINE_ORDER = ["cbetTurn", "facingCbetTurn", "checkRaiseTurn", "donkTurn"];
export const RIVER_LINE_ORDER = ["cbetRiver", "facingCbetRiver", "checkRaiseRiver", "donkRiver"];
export const FLOP_SUITS_ORDER = ["rainbow", "twoTone", "monotone"];
export const FLOP_PAIRING_ORDER = ["unpaired", "paired", "trips"];
export const FLOP_HIGH_ORDER = ["A", "K", "Q", "J", "T", "low"];
export const FLOP_CONNECT_ORDER = ["straight", "noStraight"];
export const PLAYERS_ORDER = ["2", "3", "4", "5", "6", "7plus"];
export const CONDITIONS_ORDER = ["straddle", "ante", "runItTwice"];
export const WEEKDAYS_ORDER = ["1", "2", "3", "4", "5", "6", "7"];
export const DAY_PARTS_ORDER = ["morning", "afternoon", "evening", "night"];
export const LAST_HANDS_ORDER = ["100", "500", "1000", "5000"];
export const GRADES_ORDER = ["blunder", "mistake", "inaccurate", "clean", "notAnalysed"];
export const BET_SIZE_ORDER = ["small", "medium", "large", "overbet"];
export const MADE_ORDER = [
  "fullHouse",
  "flush",
  "straight",
  "set",
  "trips",
  "twoPair",
  "overpair",
  "topPair",
  "middlePair",
  "bottomPair",
  "underpair",
  "highCard",
];
export const KICKER_ORDER = ["top", "good", "weak"];
export const DRAWS_ORDER = ["flushDraw", "nutFlushDraw", "oesd", "gutshot", "comboDraw", "backdoorFlush"];
export const POSITION_FLOP_ORDER = ["ip", "oop"];
export const PLAYERS_FLOP_ORDER = ["2", "3", "4plus"];
export const VS_TYPE_ORDER = ["fish", "reg", "unknown"];
export const LEVELS_ORDER = ["1-5", "6-10", "11-15", "16plus"];

/**
 * A typed range of big blinds: "80-120" (or "80–120", "80 to 120"), "40+"
 * (from), "<30" (up to), one number (from). Negative numbers for results
 * ("-200 to -50"). Nothing usable, both ends null.
 */
export function parseRange(text: string): { min: number | null; max: number | null } {
  const t = text.trim().replace(/,/g, ".").replace(/\u2212/g, "-");
  const num = (value: string | undefined) => {
    const n = Number(value);
    return value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
  };
  const pair = /^(-?\d+(?:\.\d+)?)\s*(?:-|\u2013|to|\.\.)\s*(-?\d+(?:\.\d+)?)$/i.exec(t);
  if (pair) {
    const a = num(pair[1]);
    const b = num(pair[2]);
    if (a !== null && b !== null) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const upTo = /^(?:<|\u2264|<=|up to)\s*(-?\d+(?:\.\d+)?)$/i.exec(t);
  if (upTo) return { min: null, max: num(upTo[1]) };
  const from = /^(?:>|\u2265|>=)?\s*(-?\d+(?:\.\d+)?)\s*\+?$/.exec(t);
  if (from) return { min: num(from[1]), max: null };
  return { min: null, max: null };
}

/** Seats in table order, as the web's filter lists them. */
export const POSITION_ORDER = ["UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
export const POT_TYPE_ORDER = ["walk", "limped", "single-raised", "3bet", "4bet+", "bomb"];
export const RESULT_ORDER = ["won", "lost", "even"];
export const STACK_ORDER = ["0-40", "40-80", "80-120", "120+"];
export const FORMAT_ORDER = ["cash", "tournament", "sng", "spin"];
export const LIMIT_ORDER = ["nl", "pl", "fl"];
export const SIZE_ORDER = ["hu", "6max", "full"];
export const ANONYMIZATION_ORDER = ["none", "opaque-id", "positional"];

/** A typed minimum pot as a number, or null ("", "abc", 0 and below). */
export function parseMinPot(text: string): number | null {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

/** How many of the searches are set. */
export function activeSearches(filter: FilterState): number {
  return (
    (filter.heroCards.trim() ? 1 : 0) +
    (filter.heroRange.length > 0 ? 1 : 0) +
    (filter.board.trim() ? 1 : 0) +
    (filter.playerName.trim() ? 1 : 0) +
    (filter.showdown === null ? 0 : 1) +
    (filter.tableName.trim() ? 1 : 0) +
    (parseMinPot(filter.minPot) === null ? 0 : 1)
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
    (filter.knownCards === null ? 0 : 1) +
    (filter.bounty === null ? 0 : 1) +
    ([filter.heroStack, filter.netRange, filter.evLoss, filter.openSize, filter.vsVpip, filter.buyIn].filter(
      (text) => text.trim() !== "",
    ).length) +
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

/**
 * A custom range's end given as an exact instant (an ISO date and time, as
 * the Live screen's "last session" hands over) rather than a local day.
 */
export function isInstant(value: string): boolean {
  return value.includes("T") && !Number.isNaN(Date.parse(value));
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
      // An exact instant is kept as it is: the end one second on, since
      // `to` is exclusive and the last hand was played at that instant.
      const fromInstant = isInstant(filter.dateFrom) ? new Date(filter.dateFrom) : null;
      const toInstant = isInstant(filter.dateTo) ? new Date(Date.parse(filter.dateTo) + 1000) : null;
      const from = fromInstant ?? localDay(filter.dateFrom);
      const to = localDay(filter.dateTo);
      return {
        from: from ? from.toISOString() : null,
        to: toInstant ? toInstant.toISOString() : to ? addDays(to, 1).toISOString() : null,
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
  if (filter.heroRange.length > 0) {
    // The grid's classes, narrowed by a class typed as well (both must hold).
    const typed = hero.kind === "class" ? new Set(hero.values) : null;
    query.heroHandClasses = typed ? filter.heroRange.filter((value) => typed.has(value)) : filter.heroRange;
  } else if (hero.kind === "class") {
    query.heroHandClasses = hero.values;
  }
  if (hero.kind === "cards") query.heroCards = hero.values;
  const board = extractCards(filter.board);
  if (board.length > 0) query.board = board;
  else {
    const ranks = boardRanks(filter.board);
    if (ranks.length > 0) query.boardRanks = ranks;
  }
  if (filter.playerName.trim()) query.playerName = filter.playerName.trim();
  if (filter.showdown !== null) query.showdown = filter.showdown;
  if (filter.tableName.trim()) query.tableName = filter.tableName.trim();
  const minPot = parseMinPot(filter.minPot);
  if (minPot !== null) query.minPot = minPot;
  if (filter.showdownPositions.length > 0) query.showdownPositions = filter.showdownPositions;
  if (filter.winnerPositions.length > 0) query.winnerPositions = filter.winnerPositions;
  if (filter.anonymizations.length > 0) query.anonymizations = filter.anonymizations;
  if (filter.sort !== "newest") query.sort = filter.sort;
  // The builder's groups (V1): only what is set goes, so a source that does
  // not know them reads the query it always read.
  const acts = ACT_GROUPS.map((group) => filter[group]).filter((values) => values.length > 0);
  if (acts.length > 0) query.acts = acts;
  for (const key of ["flopSuits", "flopPairing", "flopHigh", "flopConnect", "players", "conditions", "dayParts", "grades"] as const) {
    if (filter[key].length > 0) query[key] = filter[key];
  }
  if (filter.weekdays.length > 0) query.weekdays = filter.weekdays.map(Number);
  if (filter.weekdays.length > 0 || filter.dayParts.length > 0) query.utcOffsetMinutes = -now.getTimezoneOffset();
  if (filter.lastHands.length > 0) query.lastHands = Math.max(...filter.lastHands.map(Number));
  const stack = parseRange(filter.heroStack);
  if (stack.min !== null) query.heroStackMin = stack.min;
  if (stack.max !== null) query.heroStackMax = stack.max;
  const net = parseRange(filter.netRange);
  if (net.min !== null) query.netMin = net.min;
  if (net.max !== null) query.netMax = net.max;
  const evLoss = parseRange(filter.evLoss).min;
  if (evLoss !== null) query.evLossMin = evLoss;
  if (filter.knownCards !== null) query.knownCards = filter.knownCards;
  // The PHF facts (schema 19).
  const lists = {
    flopSizes: filter.flopSize,
    turnSizes: filter.turnSize,
    riverSizes: filter.riverSize,
    flopMade: filter.flopMade,
    turnMade: filter.turnMade,
    riverMade: filter.riverMade,
    kickers: filter.kicker,
    flopDraws: filter.flopDraws,
    turnDraws: filter.turnDraws,
    vsPositions: filter.vsPosition,
    positionFlop: filter.positionFlop,
    playersFlop: filter.playersFlop,
    vsTypes: filter.vsType,
    levels: filter.levels,
  } as const;
  for (const [key, values] of Object.entries(lists) as [keyof typeof lists, string[]][]) {
    if (values.length > 0) query[key] = values;
  }
  const open = parseRange(filter.openSize);
  if (open.min !== null) query.openMin = open.min;
  if (open.max !== null) query.openMax = open.max;
  const vpip = parseRange(filter.vsVpip);
  if (vpip.min !== null) query.vsVpipMin = vpip.min;
  if (vpip.max !== null) query.vsVpipMax = vpip.max;
  const buyIn = parseRange(filter.buyIn);
  if (buyIn.min !== null) query.buyInMin = buyIn.min;
  if (buyIn.max !== null) query.buyInMax = buyIn.max;
  if (filter.bounty !== null) query.bounty = filter.bounty;
  return query;
}

/**
 * A board typed as ranks alone ("K75", "k 7 5", "T-9-8"): its ranks, a rank
 * twice for a pair, whatever the suits (the owner's ask, 2026-11-05). Empty
 * for anything else (cards with suits are `extractCards`'s).
 */
export function boardRanks(raw: string): string[] {
  const text = raw.replace(/10/g, "T").replace(/[\s,;\-/]+/g, "").toUpperCase();
  if (text.length === 0 || text.length > 5 || !/^[2-9TJQKA]+$/.test(text)) return [];
  return [...text];
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
  const text = (key: "dateFrom" | "dateTo" | "heroCards" | "board" | "playerName" | "tableName" | "minPot"): string => {
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
    // All-in and the winners' positions are no longer filters (2026-11-05):
    // a saved filter that set them shows every hand as to those.
    allIn: null,
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
    heroRange: Array.isArray(saved.heroRange)
      ? saved.heroRange.filter((item): item is string => typeof item === "string" && HAND_CLASSES.has(item))
      : [],
    board: text("board"),
    playerName: text("playerName"),
    showdown: flag("showdown"),
    tableName: text("tableName"),
    minPot: text("minPot"),
    showdownPositions: list("showdownPositions"),
    winnerPositions: [],
    anonymizations: list("anonymizations"),
    sort: typeof sort === "string" && (SORTS as string[]).includes(sort) ? (sort as HandSort) : "newest",
    preflopDid: list("preflopDid"),
    preflopFaced: list("preflopFaced"),
    preflopRole: list("preflopRole"),
    streets: list("streets"),
    flopLine: list("flopLine"),
    turnLine: list("turnLine"),
    riverLine: list("riverLine"),
    flopSuits: list("flopSuits"),
    flopPairing: list("flopPairing"),
    flopHigh: list("flopHigh"),
    flopConnect: list("flopConnect"),
    players: list("players"),
    conditions: list("conditions"),
    weekdays: list("weekdays"),
    dayParts: list("dayParts"),
    lastHands: list("lastHands"),
    grades: list("grades"),
    heroStack: typeof saved.heroStack === "string" ? saved.heroStack : "",
    netRange: typeof saved.netRange === "string" ? saved.netRange : "",
    evLoss: typeof saved.evLoss === "string" ? saved.evLoss : "",
    knownCards: typeof saved.knownCards === "boolean" ? saved.knownCards : null,
    flopSize: list("flopSize"),
    turnSize: list("turnSize"),
    riverSize: list("riverSize"),
    flopMade: list("flopMade"),
    turnMade: list("turnMade"),
    riverMade: list("riverMade"),
    kicker: list("kicker"),
    flopDraws: list("flopDraws"),
    turnDraws: list("turnDraws"),
    vsPosition: list("vsPosition"),
    positionFlop: list("positionFlop"),
    playersFlop: list("playersFlop"),
    vsType: list("vsType"),
    levels: list("levels"),
    openSize: typeof saved.openSize === "string" ? saved.openSize : "",
    vsVpip: typeof saved.vsVpip === "string" ? saved.vsVpip : "",
    buyIn: typeof saved.buyIn === "string" ? saved.buyIn : "",
    bounty: typeof saved.bounty === "boolean" ? saved.bounty : null,
  };
}

/** The 169 starting-hand classes as the grid writes them: "AA", "AKs", "AKo" (the higher rank first). */
const HAND_CLASSES: ReadonlySet<string> = new Set(
  [..."AKQJT98765432"].flatMap((high, i, ranks) =>
    ranks.slice(i).flatMap((low, j) => (j === 0 ? [high + low] : [`${high}${low}s`, `${high}${low}o`])),
  ),
);

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
