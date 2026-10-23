/**
 * The Hands screen's data, as both surfaces hand it over (R4.5b).
 *
 * The screen (`HandsScreen.tsx`) was the desktop app's (R2.7a); since R4.5
 * the web's library renders it too. Each surface keeps its own data layer and
 * implements `HandsSource` over it: the app over Tauri commands into its local
 * store (`app/src/lib/handsSource.ts`), the web over Supabase
 * (`frontend/src/lib/db/handsSource.ts`, `library_page` / `library_facets`).
 * The shapes are the app's store DTOs (`hands::HandRowDto`, `FacetsDto`), with
 * the few fields only one surface has made optional.
 */

/** What the list is asked for: every group "any" when empty. */
export interface HandFilter {
  sites?: string[];
  formats?: string[];
  variants?: string[];
  limits?: string[];
  /** `hu`, `6max`, `full`. */
  sizes?: string[];
  /** `USD:200`, `chips`. */
  stakes?: string[];
  positions?: string[];
  potTypes?: string[];
  /** `won`, `lost`, `even`. */
  results?: string[];
  /** `0-40`, `40-80`, `80-120`, `120+` (big blinds). */
  stacks?: string[];
  allIn?: boolean | null;
  hasNote?: boolean | null;
  tags?: string[];
  /** ISO instants: from (inclusive), to (exclusive). */
  from?: string | null;
  to?: string | null;
  /** Hands this opponent was dealt into (the app's Players screen). */
  player?: PlayerRef | null;
  /**
   * Searches (the web's library had them before R4.5; `HandsSource.features
   * .search`): every one of these cards in the hero's hand, the hero's
   * starting-hand class, every one of these cards on the board, a name at
   * the table.
   */
  heroCards?: string[];
  heroHandClasses?: string[];
  board?: string[];
  playerName?: string | null;
  /** Only hands that went to showdown (`true`), or only the others. */
  showdown?: boolean | null;
  /**
   * The web library's other filters (`HandsSource.features.more`): a part of
   * the table's name; the smallest total pot in the hand's own unit (25 is
   * $25 at a dollar table, 25 chips in a tournament); any of these positions
   * reached showdown / won a pot; what the room's names are
   * (`none`, `positional`, `opaque-id`).
   */
  tableName?: string | null;
  minPot?: number | null;
  showdownPositions?: string[];
  winnerPositions?: string[];
  anonymizations?: string[];
  /** `HandsSource.features.sorts`; newest first when absent. */
  sort?: HandSort;
}

/** The list's orders. `newest` is the only one every source has. */
export type HandSort = "newest" | "oldest" | "pot" | "won" | "lost";

/** Filters a source may offer beyond the common groups (the web library's). */
export type MoreFilter = "tableName" | "minPot" | "showdownPositions" | "winnerPositions" | "anonymization";

/** An opponent of a room with real screen names: the site key and the name as printed. */
export interface PlayerRef {
  site: string;
  player: string;
}

/** Where the next page starts; opaque to the screen (each source has its own). */
export type HandCursor = unknown;

/** One row of the list. Money in minor units. */
export interface HandRow {
  /** The row's key: the app's hand key, the web's `hands.id`. */
  handKey: string;
  site: string;
  siteName: string;
  siteHandId: string;
  playedAt: string | null;
  gameFormat: string;
  variant: string;
  limitType: string;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  maxSeats: number;
  tableName: string | null;
  heroPosition: string | null;
  heroCards: string[];
  board: string[];
  heroNet: number | null;
  /** Thousandths of a big blind. */
  heroNetBbMilli: number | null;
  /** All in with cards to come. */
  allIn: boolean;
  /** The all-in EV result where it differs from the result. */
  evNet: number | null;
  evNetBbMilli: number | null;
  /** Waiting for the background EV pass. */
  evPending: boolean;
  potType: string;
  totalPot: number;
  showdown: boolean;
  hasNote: boolean;
  tags: string[];
  /** The hero's starting-hand class (`AKs`), where the source has it. */
  heroHandClass?: string | null;
  /** The room's names are seat labels that change every hand (Ignition): a mark in the list. */
  positionalNames?: boolean;
}

export interface HandPage {
  rows: HandRow[];
  next: HandCursor | null;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface SiteFacet extends FacetCount {
  name: string;
}

export interface StakeFacet extends FacetCount {
  currency: string | null;
  currencySymbol: string | null;
  minorUnits: number | null;
  smallBlind: number | null;
  bigBlind: number | null;
}

/** Each group counted as if its own selection were left out. */
export interface HandFacets {
  total: number;
  /** Every hand the reader has, for "N of M hands" (the web; the app asks its store). */
  library?: number;
  sites: SiteFacet[];
  formats: FacetCount[];
  variants: FacetCount[];
  limits: FacetCount[];
  sizes: FacetCount[];
  stakes: StakeFacet[];
  positions: FacetCount[];
  potTypes: FacetCount[];
  results: FacetCount[];
  stacks: FacetCount[];
  allIn: FacetCount[];
  /** Every tag in use, with its hands (a source with tags). */
  tags: FacetCount[];
  /** Hands with a note (a source with notes). */
  noted: number;
  /** What the rooms' names are, `none` / `positional` / `opaque-id` (a source with that filter). */
  anonymizations?: FacetCount[];
}

/** A saved filter: its id, its name and the screen's state as JSON. */
export interface SavedFilter {
  id: number | string;
  name: string;
  filter: string;
}

/** Whose saved filters: the Hands screen's or Reports'. */
export type FilterScreen = "hands" | "reports";

/** The saved filters a surface keeps, if it keeps any. */
export interface SavedFiltersSource {
  list(screen: FilterScreen): Promise<SavedFilter[]>;
  /** Saves (the same name replaces) and returns the list. */
  save(name: string, filter: string, screen: FilterScreen): Promise<SavedFilter[]>;
  remove(id: SavedFilter["id"], screen: FilterScreen): Promise<SavedFilter[]>;
}

/** What the screen asks a surface for. */
export interface HandsSource {
  page(filter: HandFilter, after: HandCursor | null, limit: number): Promise<HandPage>;
  facets(filter: HandFilter): Promise<HandFacets>;
  /**
   * Tells the screen the hands changed (an import, a sync, another tab);
   * returns the unsubscribe. The screen re-reads its first page and puts what
   * is newer on top.
   */
  onChanged?(listener: () => void): () => void;
  /** What this source can do beyond the common list. */
  features: HandsFeatures;
  savedFilters?: SavedFiltersSource;
}

export interface HandsFeatures {
  /** Tags and notes: their filter groups and the list's marks. */
  annotations: boolean;
  /** The searches of `HandFilter` (cards, class, board, a name, showdown). */
  search: boolean;
  /** The orders it can list in, besides newest first. */
  sorts: HandSort[];
  /**
   * The other filters it has; the screen hides the rest. The position lists,
   * the table and the minimum pot narrow the counts and have none of their
   * own; the names group is counted.
   */
  more: MoreFilter[];
}

/** The text a surface reports for a failed call. */
export function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string") {
    return reason.message;
  }
  return String(reason);
}
