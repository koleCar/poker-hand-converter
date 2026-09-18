/**
 * DEPRECATED compatibility shim. Import from `./db` instead.
 *
 * The real data layer is now `frontend/src/lib/db/`, typed against PHF and the
 * `hands` / `unparsed_hands` / `shares` schema. This file only exists so the
 * components that still import the pre-PHF API keep compiling and working while
 * they are migrated. Delete it once nothing imports it.
 *
 * Two differences are worth knowing while it is still around:
 *
 *  * The database stores **integer minor units**; the old `StoredHandRow`
 *    carried display numbers. The rows produced here are converted back to
 *    display numbers so existing components render correctly, which means they
 *    are lossy for chip-denominated games.
 *  * `saveHandsFromGgText` and `saveSingleHand` now go through the PHF standard
 *    text parser, so they store real PHF documents rather than a legacy shape.
 *    A hand the PHF parser rejects is counted as `failed`.
 */

import { parseStandardText } from "./phf/serialize";
import type { ParsedHand } from "./handParser";
import {
  countHands as countHandsNew,
  findHandId,
  getHand,
  handFiltersFromForm,
  handKeyOf,
  saveHands,
  searchHands as searchHandsNew,
  type HandFilterForm,
  type HandSummary,
} from "./db";

/** @deprecated Use `HandSummary` from `./db`. */
export interface StoredHandRow {
  id: string;
  hand_key: string;
  source_hand_id: string | null;
  source: string;
  game_type: "cash" | "tournament";
  game_label: string | null;
  table_name: string | null;
  max_seats: number | null;
  played_at: string | null;
  /** Currency **symbol**, for display; the new layer exposes the code separately. */
  currency: string;
  small_blind: number | null;
  big_blind: number | null;
  hero_name: string | null;
  hero_cards: string[];
  hero_hand_class: string | null;
  board_cards: string[];
  player_names: string[];
  player_count: number | null;
  street_reached: string | null;
  went_to_showdown: boolean;
  total_pot: number | null;
  rake: number | null;
  hero_profit: number | null;
  winners: string[];
  source_text: string | null;
  source_filename: string | null;
  created_at: string;
}

/** @deprecated Use `HandFilterForm` from `./db`. */
export type HandFilters = Omit<HandFilterForm, "site" | "sort"> & {
  sort: "played_desc" | "played_asc" | "pot_desc" | "profit_desc" | "profit_asc";
};

/** @deprecated Use `EMPTY_HAND_FILTER_FORM` from `./db`. */
export const EMPTY_FILTERS: HandFilters = {
  board: "",
  heroCards: "",
  player: "",
  tableName: "",
  showdownOnly: false,
  heroWonOnly: false,
  minPot: "",
  fromDate: "",
  toDate: "",
  sort: "played_desc",
};

function display(amount: number | null, minorUnits: number): number | null {
  if (amount === null) {
    return null;
  }
  return minorUnits > 1 ? amount / minorUnits : amount;
}

function toLegacyRow(row: HandSummary): StoredHandRow {
  const unit = row.currencyMinorUnits || 1;
  return {
    id: row.id,
    hand_key: row.handKey,
    source_hand_id: row.siteHandId,
    source: row.site,
    game_type: row.gameFormat === "cash" ? "cash" : "tournament",
    game_label: row.variant,
    table_name: row.tableName,
    max_seats: row.maxSeats,
    played_at: row.playedAt,
    currency: row.currencySymbol ?? "",
    small_blind: display(row.smallBlind, unit),
    big_blind: display(row.bigBlind, unit),
    hero_name: row.heroName,
    hero_cards: row.heroCards,
    hero_hand_class: row.heroHandClass,
    board_cards: row.boardCards,
    player_names: row.playerNames,
    player_count: row.playerCount,
    street_reached: row.streetReached,
    went_to_showdown: row.wentToShowdown,
    total_pot: display(row.totalPot, unit),
    rake: display(row.rake, unit),
    hero_profit: display(row.heroProfit, unit),
    winners: row.winners,
    source_text: null,
    source_filename: row.sourceFilename,
    created_at: row.createdAt,
  };
}

/** @deprecated */
export interface SaveResult {
  parsed: number;
  saved: number;
  duplicates: number;
  failed: number;
  errors: string[];
}

/** @deprecated Use `saveHands()` from `./db` with PHF hands. */
export async function saveHandsFromGgText(
  ggText: string,
  meta: { source?: string; sourceFilename?: string | null } = {},
): Promise<SaveResult> {
  const hands = parseStandardText(ggText, {
    siteId: meta.source ?? "standard",
    siteName: meta.source ?? "PokerConverter standard",
    originalFilename: meta.sourceFilename ?? null,
  });

  const result = await saveHands(hands);
  return {
    parsed: hands.length,
    saved: result.inserted,
    duplicates: result.duplicates,
    failed: result.errors.length > 0 ? result.received - result.inserted - result.duplicates : 0,
    errors: result.errors,
  };
}

/** @deprecated Use `saveHand()` from `./db` with a PHF hand. */
export async function saveSingleHand(
  hand: ParsedHand,
  meta: { source?: string; sourceText?: string | null; sourceFilename?: string | null } = {},
): Promise<{ saved: boolean; duplicate: boolean; id: string | null }> {
  const [phf] = parseStandardText(hand.rawText, {
    siteId: meta.source ?? "standard",
    siteName: meta.source ?? "PokerConverter standard",
    originalFilename: meta.sourceFilename ?? null,
  });
  if (!phf) {
    throw new Error("This hand could not be parsed into the canonical format.");
  }

  const result = await saveHands([phf]);
  if (result.errors.length > 0) {
    throw new Error(result.errors[0]);
  }
  const id = await findHandId(handKeyOf(phf));
  return { saved: result.inserted > 0, duplicate: result.inserted === 0, id };
}

/** @deprecated Use `searchHands()` from `./db`. */
export async function searchHands(
  filters: HandFilters,
  page: { offset: number; limit: number },
): Promise<{ rows: StoredHandRow[]; total: number }> {
  const result = await searchHandsNew(
    handFiltersFromForm({ ...filters, site: "" } as HandFilterForm),
    page,
  );
  return { rows: result.rows.map(toLegacyRow), total: result.total };
}

/** @deprecated Use `getHand()` from `./db` and read `standardText`. */
export async function fetchHandText(id: string): Promise<string> {
  const record = await getHand(id);
  if (!record) {
    throw new Error("Hand not found.");
  }
  return record.standardText;
}

/** @deprecated Use `countHands()` from `./db`. */
export async function countHands(): Promise<number> {
  return countHandsNew();
}
