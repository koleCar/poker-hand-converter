import { extractCards, resolveHeroQuery } from "./cards";
import {
  heroCards,
  heroHandClass,
  parseHand,
  splitHands,
  type ParsedHand,
} from "./handParser";
import { requireSupabase, supabase } from "./supabase";

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
  hand_text: string;
  source_text: string | null;
  source_filename: string | null;
  created_at: string;
}

/** The column list used for list views; `hand_text` is fetched lazily. */
const LIST_COLUMNS =
  "id,hand_key,source,game_type,game_label,table_name,max_seats,played_at,currency," +
  "small_blind,big_blind,hero_name,hero_cards,hero_hand_class,board_cards,player_names," +
  "player_count,street_reached,went_to_showdown,total_pot,rake,hero_profit,winners," +
  "source_filename,created_at";

export interface HandFilters {
  /** Free text of card codes; every card must be on the board. */
  board: string;
  /** Card codes or a hand class like "AKs" / "TT". */
  heroCards: string;
  player: string;
  tableName: string;
  showdownOnly: boolean;
  heroWonOnly: boolean;
  minPot: string;
  fromDate: string;
  toDate: string;
  sort: "played_desc" | "played_asc" | "pot_desc" | "profit_desc" | "profit_asc";
}

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

export function toRow(
  hand: ParsedHand,
  meta: { source?: string; sourceText?: string | null; sourceFilename?: string | null } = {},
) {
  const hero = heroCards(hand);
  return {
    hand_key: hand.handKey,
    source_hand_id: hand.handId,
    source: meta.source ?? "weplay",
    game_type: hand.gameType,
    game_label: hand.gameLabel,
    table_name: hand.tableName,
    max_seats: hand.maxSeats || null,
    played_at: hand.playedAt,
    currency: hand.currency,
    small_blind: hand.smallBlind || null,
    big_blind: hand.bigBlind || null,
    hero_name: hand.heroName,
    hero_cards: hero,
    hero_hand_class: heroHandClass(hand),
    board_cards: hand.board,
    player_names: hand.seats.map((seat) => seat.name),
    player_count: hand.seats.length,
    street_reached: hand.streetReached,
    went_to_showdown: hand.wentToShowdown,
    total_pot: hand.totalPot,
    rake: hand.rake,
    hero_profit: hand.heroProfit,
    winners: hand.winners.map((winner) => winner.player),
    hand_text: hand.rawText,
    source_text: meta.sourceText ?? null,
    source_filename: meta.sourceFilename ?? null,
  };
}

export interface SaveResult {
  parsed: number;
  saved: number;
  duplicates: number;
  failed: number;
  errors: string[];
}

/**
 * Parses GG-format text and upserts every valid hand. Duplicates are resolved
 * on `hand_key`, so re-uploading the same file is a no-op.
 */
export async function saveHandsFromGgText(
  ggText: string,
  meta: { source?: string; sourceFilename?: string | null } = {},
): Promise<SaveResult> {
  const client = requireSupabase();
  const chunks = splitHands(ggText);
  const result: SaveResult = {
    parsed: 0,
    saved: 0,
    duplicates: 0,
    failed: 0,
    errors: [],
  };

  const rows = [];
  const seenKeys = new Set<string>();
  for (const chunk of chunks) {
    const hand = parseHand(chunk);
    if (!hand) {
      result.failed += 1;
      continue;
    }
    result.parsed += 1;
    if (seenKeys.has(hand.handKey)) {
      result.duplicates += 1;
      continue;
    }
    seenKeys.add(hand.handKey);
    rows.push(toRow(hand, { ...meta, sourceFilename: meta.sourceFilename ?? null }));
  }

  if (rows.length === 0) {
    return result;
  }

  const existing = new Set<string>();
  // Probe in pages so the `in.(...)` filter stays inside URL length limits.
  for (let i = 0; i < rows.length; i += 200) {
    const keys = rows.slice(i, i + 200).map((row) => row.hand_key);
    const { data, error } = await client
      .from("stored_hands")
      .select("hand_key")
      .in("hand_key", keys);
    if (error) {
      result.errors.push(error.message);
      continue;
    }
    for (const row of data ?? []) {
      existing.add(row.hand_key);
    }
  }

  const fresh = rows.filter((row) => !existing.has(row.hand_key));
  result.duplicates += rows.length - fresh.length;

  for (let i = 0; i < fresh.length; i += 100) {
    const batch = fresh.slice(i, i + 100);
    const { error } = await client
      .from("stored_hands")
      .upsert(batch, { onConflict: "hand_key", ignoreDuplicates: true });
    if (error) {
      result.failed += batch.length;
      result.errors.push(error.message);
      continue;
    }
    result.saved += batch.length;
  }

  return result;
}

export async function saveSingleHand(
  hand: ParsedHand,
  meta: { source?: string; sourceText?: string | null; sourceFilename?: string | null } = {},
): Promise<{ saved: boolean; duplicate: boolean; id: string | null }> {
  const client = requireSupabase();
  const { data: existing } = await client
    .from("stored_hands")
    .select("id")
    .eq("hand_key", hand.handKey)
    .maybeSingle();

  if (existing) {
    return { saved: false, duplicate: true, id: existing.id };
  }

  const { data, error } = await client
    .from("stored_hands")
    .insert(toRow(hand, meta))
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }
  return { saved: true, duplicate: false, id: data.id };
}

export interface SearchResult {
  rows: StoredHandRow[];
  total: number;
}

export async function searchHands(
  filters: HandFilters,
  page: { offset: number; limit: number },
): Promise<SearchResult> {
  const client = requireSupabase();
  let query = client.from("stored_hands").select(LIST_COLUMNS, { count: "exact" });

  const boardCards = extractCards(filters.board);
  if (boardCards.length > 0) {
    query = query.contains("board_cards", boardCards);
  }

  const hero = resolveHeroQuery(filters.heroCards);
  if (hero.kind === "class") {
    query = query.in("hero_hand_class", hero.values);
  } else if (hero.kind === "cards") {
    query = query.contains("hero_cards", hero.values);
  } else if (filters.heroCards.trim()) {
    // Unparseable input should return nothing rather than everything.
    query = query.eq("hero_hand_class", "__no_match__");
  }

  const player = filters.player.trim();
  if (player) {
    query = query.contains("player_names", [player]);
  }

  const tableName = filters.tableName.trim();
  if (tableName) {
    query = query.ilike("table_name", `%${tableName}%`);
  }

  if (filters.showdownOnly) {
    query = query.eq("went_to_showdown", true);
  }

  if (filters.heroWonOnly) {
    query = query.gt("hero_profit", 0);
  }

  const minPot = Number(filters.minPot);
  if (filters.minPot.trim() && Number.isFinite(minPot)) {
    query = query.gte("total_pot", minPot);
  }

  if (filters.fromDate) {
    query = query.gte("played_at", new Date(filters.fromDate).toISOString());
  }
  if (filters.toDate) {
    const to = new Date(filters.toDate);
    to.setHours(23, 59, 59, 999);
    query = query.lte("played_at", to.toISOString());
  }

  switch (filters.sort) {
    case "played_asc":
      query = query.order("played_at", { ascending: true, nullsFirst: false });
      break;
    case "pot_desc":
      query = query.order("total_pot", { ascending: false, nullsFirst: false });
      break;
    case "profit_desc":
      query = query.order("hero_profit", { ascending: false, nullsFirst: false });
      break;
    case "profit_asc":
      query = query.order("hero_profit", { ascending: true, nullsFirst: false });
      break;
    default:
      query = query.order("played_at", { ascending: false, nullsFirst: false });
      break;
  }

  const { data, error, count } = await query.range(
    page.offset,
    page.offset + page.limit - 1,
  );

  if (error) {
    throw new Error(error.message);
  }

  return {
    rows: (data ?? []) as unknown as StoredHandRow[],
    total: count ?? 0,
  };
}

export async function fetchHandText(id: string): Promise<string> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("stored_hands")
    .select("hand_text")
    .eq("id", id)
    .single();
  if (error) {
    throw new Error(error.message);
  }
  return data.hand_text as string;
}

export async function countHands(): Promise<number> {
  if (!supabase) {
    return 0;
  }
  const { count, error } = await supabase
    .from("stored_hands")
    .select("id", { count: "exact", head: true });
  if (error) {
    return 0;
  }
  return count ?? 0;
}
