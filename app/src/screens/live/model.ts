/**
 * The Live screen's pure helpers: which statistics it shows, a statistic's
 * target range (its definition's "normal" colour band, `config/stats/`),
 * where a value sits against it, and the hands table's page buttons and
 * order.
 * Nothing here computes a statistic (guideline §14): the value and its band
 * (`Shown.tone`) come from the store, the range from the definition.
 */
// The target range helpers moved to the shared package (the profile's cards use them too).
export {
  placeOf,
  rangeBar,
  rangeColour,
  rangeScore,
  targetRange,
  type RangeBar,
  type TargetRange,
} from "@rail/ui/stats/range";

/** The session's statistics, in this order. The win rates (bb/100, EV bb/100) are in the graph's toolbar, not here. */
export const LIVE_STATS = [
  "vpip",
  "pfr",
  "three_bet",
  "fold_to_three_bet",
  "cbet_flop",
  "aggression_frequency",
  "wtsd",
  "wsd",
] as const;

/** Rows in one page of the hands table, until the reader picks another size. */
export const HANDS_PER_PAGE = 10;

/** The hands table's page sizes; `null` is every hand on one page. */
export const PAGE_SIZES = [10, 25, 100, null] as const;

/** One of `PAGE_SIZES`. */
export type PageSize = (typeof PAGE_SIZES)[number];

/** A stored page size ("10", "25", "100", "all"); anything else is the default. */
export function parsePageSize(text: string | null): PageSize {
  if (text === "all") return null;
  return PAGE_SIZES.find((size) => size !== null && String(size) === text) ?? HANDS_PER_PAGE;
}

/** A page size as stored. */
export function pageSizeText(size: PageSize): string {
  return size === null ? "all" : String(size);
}

/**
 * The page that keeps the reader's first row in view when the page size
 * changes: the row at index `first` (0-based) lands on this 1-based page.
 */
export function pageForRow(first: number, size: PageSize): number {
  return size === null ? 1 : Math.floor(Math.max(0, first) / size) + 1;
}

/** Below this the session is too short for a rate per hour. */
export const MIN_MINUTES_FOR_RATE = 10;

/** Whole minutes from one ISO instant to another, never negative. */
export function minutesBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
}

/**
 * The page buttons for `total` pages around `current` (1-based): every page
 * when there are seven or fewer, else the first, the last and the current
 * one's neighbours, a gap (`null`) between runs.
 */
export function pageList(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((page) => keep.add(page));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((page) => keep.add(page));
  const pages = [...keep].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  pages.forEach((page, i) => {
    const before = pages[i - 1];
    if (before !== undefined && page - before > 1) out.push(null);
    out.push(page);
  });
  return out;
}

/**
 * The session's result per 100 hands in its money (the toolbar's "$/100"
 * when the graph is in money). The big-blind rate is the `bb_per_100`
 * definition's; money has none, so this one is the session's own result
 * over its hands. `null` without hands.
 */
export function perHundred(amount: number, hands: number): number | null {
  return hands > 0 ? (amount / hands) * 100 : null;
}

/** The hands table's sortable columns. */
export type LiveSortColumn = "hand" | "board" | "position" | "pot" | "result";

/** A column and its direction; `null` is the table's own order, the newest hand first. */
export interface LiveSort {
  column: LiveSortColumn;
  descending: boolean;
}

/** The direction a column's first click sorts in: the biggest first, positions from the first to act. */
export const FIRST_DESCENDING: Record<LiveSortColumn, boolean> = {
  hand: true,
  board: true,
  position: false,
  pot: true,
  result: true,
};

/**
 * A header's click: a column not sorted by sorts in its first direction, the
 * sorted one turns round, and turned round once already goes back to the
 * newest first.
 */
export function nextSort(sort: LiveSort | null, column: LiveSortColumn): LiveSort | null {
  const first = FIRST_DESCENDING[column];
  if (sort === null || sort.column !== column) return { column, descending: first };
  return sort.descending === first ? { column, descending: !first } : null;
}

const RANKS = "23456789TJQKA";

/** A card's rank, 2 to 14 (`Ah`, `Td`, `10d`); 0 when unknown. */
function rankOf(card: string): number {
  const rank = card.slice(0, -1).toUpperCase();
  return rank === "10" ? 10 : RANKS.indexOf(rank) + 2 || 0;
}

/**
 * Cards as a key to compare: the most cards of one rank (pairs above
 * unpaired hands), the ranks highest first, then the most of one suit
 * (suited above offsuit).
 */
function cardsKey(cards: readonly string[]): number[] {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const most = (values: readonly (string | number)[]) => {
    const counts = new Map<string | number, number>();
    values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
    return Math.max(0, ...counts.values());
  };
  return [most(ranks), ...ranks, most(cards.map((card) => card.slice(-1).toLowerCase()))];
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What `sortHands` reads of a hand. */
export interface SortableHand {
  heroCards: string[];
  board: string[];
  heroPosition: string | null;
  totalPot: number;
  bigBlind: number;
  heroNet: number | null;
  heroNetBbMilli: number | null;
}

/**
 * The session's hands in `sort`'s order, in the screen's unit (`money`
 * compares the hands' amounts, else big blinds). A hand without the value
 * (no cards, no position, no result) goes last either way; equal hands keep
 * the newest first.
 */
export function sortHands<Row extends SortableHand>(
  rows: readonly Row[],
  sort: LiveSort | null,
  unit: "bb" | "money",
  positions: readonly string[],
): Row[] {
  if (sort === null) return [...rows];
  const value = (row: Row): number[] | null => {
    switch (sort.column) {
      case "hand":
        return row.heroCards.length > 0 ? cardsKey(row.heroCards) : null;
      case "board":
        return [row.board.length, ...cardsKey(row.board).slice(1)];
      case "position": {
        if (row.heroPosition === null) return null;
        const at = positions.indexOf(row.heroPosition);
        return [at < 0 ? positions.length : at];
      }
      case "pot":
        if (unit === "money") return [row.totalPot];
        return row.bigBlind > 0 ? [row.totalPot / row.bigBlind] : null;
      case "result":
        if (unit === "money" && row.heroNet !== null) return [row.heroNet];
        return row.heroNetBbMilli !== null ? [row.heroNetBbMilli] : null;
    }
  };
  const keyed = rows.map((row, index) => ({ row, index, key: value(row) }));
  keyed.sort((a, b) => {
    if (a.key === null || b.key === null) {
      if (a.key === b.key) return a.index - b.index;
      return a.key === null ? 1 : -1;
    }
    const order = compareKeys(a.key, b.key);
    return order !== 0 ? (sort.descending ? -order : order) : a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
}
