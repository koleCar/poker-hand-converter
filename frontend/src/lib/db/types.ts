/**
 * Types for the database layer.
 *
 * Everything the client sees is camelCase; the SQL columns are snake_case and
 * the mapping happens once, in `mapping.ts`. Money is **integer minor units**
 * end to end, exactly as in PHF: a `totalPot` of `12500` on a `$` table with
 * `currencyMinorUnits: 100` is $125.00. Use `handUnit(row)` plus PHF's
 * `formatAmount()` to render it; never divide by 100 by hand, because chip
 * tables have `currencyMinorUnits: 1`.
 */

import type { CurrencyUnit, PhfHand } from "../phf/types";

/* --------------------------------------------------------------- enums - */

/** Mirrors `PhfGame.format` and the `public.game_format` enum. */
export type GameFormat = "cash" | "tournament" | "sng" | "spin";

/** Mirrors `Street` in PHF and the `hands.street_reached` check constraint. */
export type StreetReached = "preflop" | "flop" | "turn" | "river" | "showdown";

/**
 * What the player names on a hand are worth. See `anonymization.ts`.
 *
 * `positional` rows have **no** `playerNames` and **no** `winners` — the site
 * only printed per-hand position labels, and storing them would make the
 * player filter return a different human from every row. Use the position
 * fields instead; for those sites position *is* the identity.
 */
export type SiteAnonymization = "none" | "positional" | "opaque-id";

/** The PHF position vocabulary, mirrored by the `is_position_array` constraint. */
export type PositionLabel =
  | "BTN" | "SB" | "BB" | "UTG" | "UTG+1" | "UTG+2" | "MP" | "LJ" | "HJ" | "CO";

/** Mirrors `ConversionFailure["stage"]` and `public.conversion_stage`. */
export type ConversionStage = "split" | "detect" | "parse" | "validate" | "serialize";

/** Triage lane of a row in the failure corpus. */
export type UnparsedStatus = "new" | "triaged" | "parser-written" | "wontfix";

/** Sort keys the `search_hands` RPC accepts. Anything else falls back to `played_desc`. */
export type HandSortKey =
  | "played_desc"
  | "played_asc"
  | "pot_desc"
  | "profit_desc"
  | "profit_asc"
  | "created_desc";

/* ---------------------------------------------------------------- rows - */

/**
 * A stored hand without its payload.
 *
 * This is what list and search views get: everything needed to render a row and
 * decide whether to open it, and nothing that would make a page of 50 hands
 * weigh megabytes. Call `getHand(id)` for the PHF document.
 */
export interface HandSummary {
  id: string;
  /** `"<siteId>:<PhfMeta.handKey>"`. Unique; re-uploading a file cannot duplicate it. */
  handKey: string;
  /** `PhfMeta.siteId`, lowercased. */
  site: string;
  /** The site's own hand id, verbatim. */
  siteHandId: string | null;
  /** `PhfGame.variant`: "holdem", "omaha", "omaha5", ... */
  variant: string | null;
  /** `PhfGame.limit`: "nl" | "pl" | "fl". */
  limitType: string | null;
  gameFormat: GameFormat;
  /** `PhfTournament.id`; null for cash hands. */
  tournamentId: string | null;
  /**
   * Whether `playerNames` / `winners` can be treated as identities.
   * Anything other than `"none"` means the name filter must be disabled —
   * see `hasUsablePlayerNames()`.
   */
  anonymization: SiteAnonymization;

  /** `CurrencyUnit.code`, e.g. "USD" or "CHIPS". */
  currency: string;
  /** `CurrencyUnit.minorUnits`: 100 for cash, 1 for chips. */
  currencyMinorUnits: number;
  /** `CurrencyUnit.symbol`; empty string for chips. */
  currencySymbol: string | null;

  /** Minor units. */
  smallBlind: number | null;
  /** Minor units. */
  bigBlind: number | null;
  /** Minor units. */
  ante: number | null;
  /** Pre-rendered stakes, e.g. "$0.50/$1". */
  stakesLabel: string | null;

  tableName: string | null;
  maxSeats: number | null;
  /** ISO timestamp the hand was dealt, or null when the source omitted it. */
  playedAt: string | null;

  heroName: string | null;
  heroSeat: number | null;
  /** Resolved from the button and the posted blinds, never from the site's seat labels. */
  heroPosition: PositionLabel | null;
  /** Canonical card codes, e.g. `["Ah", "Kh"]`. */
  heroCards: string[];
  /** Starting-hand class: "AKs" / "AKo" / "TT". Null for non-two-card variants. */
  heroHandClass: string | null;

  /** Primary runout only. A run-it-twice second board lives in the PHF payload. */
  boardCards: string[];
  /** Empty when `anonymization === "positional"`. Check before offering a name filter. */
  playerNames: string[];
  /**
   * Positions dealt into the hand. Empty when the button was unknown.
   * For an anonymized site this is the only per-seat roster there is.
   */
  playerPositions: PositionLabel[];
  playerCount: number | null;

  streetReached: StreetReached | null;
  wentToShowdown: boolean;
  /** Positions that reached showdown. The cross-site "which villain" field. */
  showdownPositions: PositionLabel[];
  /** Minor units, before fees. */
  totalPot: number | null;
  /** Minor units. Total fees deducted from the pot: rake plus jackpot/promo drops. */
  rake: number | null;
  /** Minor units, signed. Hero's net result. */
  heroProfit: number | null;
  /** Empty when `anonymization === "positional"`; use `winnerPositions` instead. */
  winners: string[];
  /** Positions that collected a pot. The only winner record on a positional hand. */
  winnerPositions: PositionLabel[];

  schemaVersion: string;
  parserVersion: string | null;
  sourceFilename: string | null;
  /** ISO timestamp the row was inserted (server clock; clients cannot set it). */
  createdAt: string;
}

/** A stored hand with its payload. Returned by `getHand()`. */
export interface HandRecord extends HandSummary {
  /** The canonical PHF v1 document. */
  phf: PhfHand;
  /** GG-style standard text rendered at save time. Ready for the text exporters. */
  standardText: string;
  /** The original site text this hand was converted from, when we kept it. */
  sourceText: string | null;
}

/* ------------------------------------------------------------- filters - */

/**
 * The server-side filter set, already parsed. Every field is optional; omitted
 * fields mean "no constraint".
 *
 * Use `handFiltersFromForm()` when you are wiring text inputs, so the free-text
 * card boxes are parsed the same way everywhere.
 */
export interface HandFilters {
  site?: string;
  /** Hands whose board **contains** all of these cards. */
  board?: string[];
  /** Hands where hero **holds** all of these cards. */
  heroCards?: string[];
  /** Hands whose hero hand class is any of these, e.g. `["AKs", "AKo"]`. */
  heroHandClasses?: string[];
  /** Exact hero name. */
  heroName?: string;
  /**
   * Any player at the table, exact name. Never matches `positional` hands,
   * which is correct — those rows genuinely have no known players.
   */
  player?: string;
  /** Hero sat in **any** of these positions. */
  heroPositions?: PositionLabel[];
  /** **Any** of these positions reached showdown. The "which villain" filter. */
  showdownPositions?: PositionLabel[];
  /** **Any** of these positions won a pot. */
  winnerPositions?: PositionLabel[];
  /** Restrict to rows whose names are (or are not) real identities. */
  anonymization?: SiteAnonymization;
  /** Case-insensitive substring match on the table name. */
  tableName?: string;
  variant?: string;
  limitType?: string;
  gameFormat?: GameFormat;
  tournamentId?: string;
  /** Exact big blind in minor units. */
  bigBlind?: number;
  street?: StreetReached;
  showdownOnly?: boolean;
  heroWonOnly?: boolean;
  /** Minimum total pot in minor units. */
  minPot?: number;
  /** Inclusive lower bound on `playedAt`, ISO string. */
  from?: string;
  /** Inclusive upper bound on `playedAt`, ISO string. */
  to?: string;
  sort?: HandSortKey;
}

/**
 * The text-input shape a filter bar works with.
 *
 * Kept separate from `HandFilters` on purpose: a UI holds raw strings the user
 * is still typing, while the query layer wants parsed values. `handFiltersFromForm`
 * is the one place that turns one into the other.
 */
export interface HandFilterForm {
  /** Free text of card codes; every card must be on the board. */
  board: string;
  /** Card codes ("AhKh") or a hand class ("AKs", "TT", "AK"). */
  heroCards: string;
  player: string;
  tableName: string;
  site: string;
  showdownOnly: boolean;
  heroWonOnly: boolean;
  /** Display units, e.g. "25" for $25. Converted using the selected stake's unit. */
  minPot: string;
  /** `yyyy-mm-dd`. */
  fromDate: string;
  /** `yyyy-mm-dd`. */
  toDate: string;
  sort: HandSortKey;
}

export const EMPTY_HAND_FILTER_FORM: HandFilterForm = {
  board: "",
  heroCards: "",
  player: "",
  tableName: "",
  site: "",
  showdownOnly: false,
  heroWonOnly: false,
  minPot: "",
  fromDate: "",
  toDate: "",
  sort: "played_desc",
};

/* ------------------------------------------------------------- results - */

export interface HandSearchResult {
  rows: HandSummary[];
  /** Total matching rows, ignoring the page window. */
  total: number;
  limit: number;
  offset: number;
}

export interface SaveHandsResult {
  /** Hands handed to `saveHands()` after in-memory dedupe. */
  received: number;
  /** Rows actually written. */
  inserted: number;
  /** Rows the database already had, keyed on `handKey`. */
  duplicates: number;
  /** Non-fatal errors from individual batches; the rest of the upload still went through. */
  errors: string[];
}

export interface RecordFailuresResult {
  received: number;
  /** Fingerprints seen for the first time. */
  created: number;
  /** Known fingerprints whose occurrence counter was bumped. */
  updated: number;
  /** Records the server refused: bad fingerprint, empty text, or over the 128 KiB cap. */
  skipped: number;
  errors: string[];
}

/** One distinct value plus how many hands carry it. */
export interface FacetCount {
  value: string;
  count: number;
}

export interface StakeFacet {
  /** Minor units. */
  bigBlind: number;
  label: string | null;
  currency: string;
  count: number;
}

/** Every distinct filter value the browse UI can offer, in one round trip. */
export interface HandFacets {
  total: number;
  sites: FacetCount[];
  heroes: FacetCount[];
  tables: string[];
  stakes: StakeFacet[];
  variants: string[];
  limitTypes: string[];
  gameFormats: GameFormat[];
  heroHandClasses: string[];
  streets: StreetReached[];
  /** Hero positions with counts; a lopsided distribution is itself informative. */
  heroPositions: FacetCount[];
  /** Villain positions that actually reach showdown in the stored corpus. */
  showdownPositions: PositionLabel[];
  /**
   * How many hands fall into each anonymization class. When every row is
   * `none` the UI can offer the name filter unconditionally; otherwise it has
   * to branch per row.
   */
  anonymizations: FacetCount[];
  playedAtRange: { min: string | null; max: string | null };
  /** Rows in the failure corpus, so the UI can badge the "unsupported" tab. */
  unparsedTotal: number;
}

/* ------------------------------------------------- unparsed / failures - */

/** A row of the failure corpus. */
export interface UnparsedHand {
  id: string;
  /** sha-256 hex of the whitespace-normalized raw text. */
  fingerprint: string;
  rawText: string;
  detectedSite: string | null;
  detectionConfidence: number | null;
  stage: ConversionStage;
  /** Machine code, e.g. "unknown-site". */
  reason: string;
  /** Human readable. */
  message: string;
  parserVersion: string;
  sourceFilename: string | null;
  status: UnparsedStatus;
  notes: string | null;
  /** How many times this exact text has been submitted. */
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One `(site, stage, reason, status)` bucket of the failure corpus. */
export interface UnparsedGap {
  detectedSite: string;
  stage: ConversionStage;
  reason: string;
  status: UnparsedStatus;
  /** Distinct fingerprints in this bucket. */
  distinctHands: number;
  /** Sum of occurrence counters; the "how much does this hurt" number. */
  totalOccurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Answers "which converter do we build next". */
export interface UnparsedSummary {
  /** Distinct unconvertible hands. */
  total: number;
  /** Sum of all occurrence counters. */
  occurrences: number;
  byStatus: Partial<Record<UnparsedStatus, number>>;
  /** Ordered by `totalOccurrences`, descending. */
  gaps: UnparsedGap[];
}

/* -------------------------------------------------------------- shares - */

export interface CreateShareInput {
  /**
   * Row id of an already-stored hand. Preferred: the share then stays in sync
   * with the stored row instead of pinning a copy.
   */
  handId?: string | null;
  /** Alias for `handId`, accepted for the share UI's request shape. */
  storedHandId?: string | null;
  /** PHF payload to embed when the hand was never saved. Ignored if `handId` is set. */
  phf?: PhfHand | unknown;
  /** Standard text to embed alongside `phf`. Ignored if `handId` is set. */
  standardText?: string | null;
  /** Alias for `standardText`. */
  handText?: string | null;
  /** Optional human label shown on the share page. */
  title?: string | null;
}

export interface ShareRef {
  id: string;
  /** Short, URL-safe, server-generated. Put it in `/h/<slug>`. */
  slug: string;
  reused: false;
}

/** What `resolveShare()` returns. Null means "no such slug". */
export interface ResolvedShare {
  slug: string;
  title: string | null;
  /** View counter *after* this resolve; every resolve counts as a view. */
  views: number;
  createdAt: string | null;
  /** Row id when the share points at a stored hand, null for an embedded payload. */
  storedHandId: string | null;
  /** The canonical PHF document, from the stored hand or the embedded copy. */
  phf: PhfHand | null;
  /** GG-style standard text, ready for the replayer's text parser. */
  standardText: string;
  /** Alias of `standardText`, for the share UI's `ResolvedShare` shape. */
  handText: string;
  /** Full stored row when the share points at one. */
  hand: HandRecord | null;
  /** Always null here; the share UI builds its own preview from `phf`. */
  preview: null;
}

/* --------------------------------------------------------------- misc - */

/**
 * Rebuilds a PHF `CurrencyUnit` from a stored row, so amounts can be rendered
 * with `formatAmount()` from `lib/phf/types` instead of ad-hoc division.
 */
export function handUnit(row: Pick<HandSummary, "currency" | "currencyMinorUnits" | "currencySymbol">): CurrencyUnit {
  return {
    code: row.currency,
    symbol: row.currencySymbol ?? "",
    minorUnits: row.currencyMinorUnits || 1,
    kind: row.currencyMinorUnits > 1 ? "cash" : "chips",
  };
}
