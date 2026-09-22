/**
 * Reading and writing converted hands.
 */

import { extractCards, resolveHeroQuery } from "../cards";
import { toStandardText } from "../phf/serialize";
import type { PhfHand } from "../phf/types";
import { currentUserId, isDatabaseConfigured, requireDb, requireUserId, rpc } from "./client";
import { handInsertFromPhf, handKeyOf, toHandRecord, toHandSummary, type HandInsert } from "./mapping";
import type {
  HandFacets,
  HandFilterForm,
  HandFilters,
  HandRecord,
  HandSearchResult,
  HandSummary,
  SaveHandsResult,
  StreetReached,
} from "./types";

export { handKeyOf };

/** A hand to save, optionally with standard text that was already rendered. */
export interface SaveHandInput {
  hand: PhfHand;
  /** Pre-rendered GG-style text. Computed with `toStandardText()` when omitted. */
  standardText?: string;
}

export interface SaveHandsOptions {
  /** Called after each batch with the number of hands processed so far. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Hard ceiling enforced by the `save_hands` RPC. Kept lower here because the
 * payload, not the row count, is what actually limits a request: a hand carries
 * its PHF document, its standard text and its original source text.
 */
const MAX_HANDS_PER_REQUEST = 100;
const MAX_BYTES_PER_REQUEST = 1_500_000;

function asInput(entry: PhfHand | SaveHandInput): SaveHandInput {
  return "hand" in entry ? entry : { hand: entry };
}

/**
 * Splits rows into request-sized batches.
 *
 * Bounded by both count and serialized size: 100 tiny heads-up hands and 100
 * nine-handed run-it-twice hands differ by an order of magnitude in bytes, and
 * only the byte count decides whether the request survives.
 */
function batchRows(rows: HandInsert[]): HandInsert[][] {
  const batches: HandInsert[][] = [];
  let current: HandInsert[] = [];
  let bytes = 0;

  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length > 0 && (current.length >= MAX_HANDS_PER_REQUEST || bytes + size > MAX_BYTES_PER_REQUEST)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * Saves converted hands into the signed-in user's library, deduping on `handKey`.
 *
 * Safe to call with the same hands twice: the unique index resolves duplicates
 * server-side, so a re-uploaded file reports `duplicates` instead of creating
 * copies. A 5000-hand upload becomes a few dozen requests, not 5000 — and no
 * "which of these already exist" probe, because the RPC returns exact counts.
 *
 * Dedupe is per library — `(owner_id, hand_key)` — so uploading a hand another
 * account already has is a new row, not a duplicate. Sharing a dedupe key
 * across accounts would tell the second uploader "already stored" and then show
 * them nothing, because the row they collided with is not theirs to read.
 *
 * Throws `SignInRequiredError` with nothing sent when there is no session: this
 * is the write that the whole login exists for. Batches that fail for other
 * reasons do not abort the rest of the upload; their errors are collected in
 * `result.errors` so a single bad hand cannot cost you the file.
 */
export async function saveHands(
  hands: Array<PhfHand | SaveHandInput>,
  options: SaveHandsOptions = {},
): Promise<SaveHandsResult> {
  const result: SaveHandsResult = { received: 0, inserted: 0, duplicates: 0, errors: [] };
  if (hands.length === 0) {
    return result;
  }
  await requireUserId();

  // Dedupe inside the upload first: a file that contains the same hand twice
  // should not spend a round trip discovering that.
  const seen = new Set<string>();
  const rows: HandInsert[] = [];
  for (const entry of hands) {
    const { hand, standardText } = asInput(entry);
    const key = handKeyOf(hand);
    if (seen.has(key)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(key);
    rows.push(handInsertFromPhf(hand, standardText ?? toStandardText(hand)));
  }
  result.received = rows.length;

  const batches = batchRows(rows);
  let done = 0;
  for (const batch of batches) {
    try {
      const payload = await rpc<{ received: number; inserted: number; duplicates: number }>(
        "save_hands",
        { p_hands: batch },
      );
      result.inserted += payload.inserted ?? 0;
      result.duplicates += payload.duplicates ?? 0;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    done += batch.length;
    options.onProgress?.(done, rows.length);
  }

  return result;
}

/** Convenience wrapper for the single-hand case (the replayer's "save this hand"). */
export async function saveHand(
  hand: PhfHand,
  standardText?: string,
): Promise<{ saved: boolean; duplicate: boolean; handKey: string }> {
  const result = await saveHands([{ hand, standardText }]);
  if (result.errors.length > 0) {
    throw new Error(result.errors[0]);
  }
  return {
    saved: result.inserted > 0,
    duplicate: result.inserted === 0,
    handKey: handKeyOf(hand),
  };
}

/* -------------------------------------------------------------- reading - */

export interface HandPage {
  offset: number;
  limit: number;
}

/**
 * Filtered, sorted, paginated list of **the caller's own** hands, plus the
 * total count, in one request.
 *
 * The scoping is not applied here and cannot be bypassed here: `search_hands`
 * is `security invoker`, so the `hands_owner_select` policy rewrites the query
 * server-side. There is no filter key for "somebody else's hands" because there
 * is no query that could carry one.
 *
 * Returns an empty page rather than throwing when signed out — the library is a
 * passive part of a page a guest is allowed to be on, and an empty list under a
 * "sign in to see your hands" prompt reads better than an error.
 *
 * The heavy columns are not in the response; call `getHand(id)` when the user
 * actually opens a hand.
 */
export async function searchHands(
  filters: HandFilters = {},
  page: HandPage = { offset: 0, limit: 25 },
): Promise<HandSearchResult> {
  if (!(await currentUserId())) {
    return { rows: [], total: 0, limit: page.limit, offset: page.offset };
  }
  const payload = await rpc<{ rows: Record<string, unknown>[]; total: number; limit: number; offset: number }>(
    "search_hands",
    { p_filters: filters, p_limit: page.limit, p_offset: page.offset },
  );
  return {
    rows: (payload.rows ?? []).map(toHandSummary),
    total: payload.total ?? 0,
    limit: payload.limit ?? page.limit,
    offset: payload.offset ?? page.offset,
  };
}

/**
 * Full stored hand including its PHF document.
 *
 * Null when the id is unknown **or belongs to somebody else** — RLS makes the
 * two indistinguishable, which is the right answer to a guessed uuid.
 */
export async function getHand(id: string): Promise<HandRecord | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const row = await rpc<Record<string, unknown> | null>("get_hand", { p_id: id });
  return row ? toHandRecord(row) : null;
}

/**
 * Row id for a dedupe key, or null when the hand is not stored.
 *
 * Useful right after `saveHands()`, which reports counts rather than ids
 * because a batch insert that skips duplicates cannot return a row per input.
 */
export async function findHandId(handKey: string): Promise<string | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const client = requireDb();
  const { data, error } = await client
    .from("hands")
    .select("id")
    .eq("hand_key", handKey)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data?.id as string | undefined) ?? null;
}

/** An empty facet set, so a signed-out filter bar renders instead of erroring. */
const NO_FACETS: HandFacets = {
  total: 0,
  sites: [],
  heroes: [],
  tables: [],
  stakes: [],
  variants: [],
  limitTypes: [],
  gameFormats: [],
  heroHandClasses: [],
  streets: [],
  heroPositions: [],
  showdownPositions: [],
  anonymizations: [],
  playedAtRange: { min: null, max: null },
  unparsedTotal: 0,
};

/**
 * Every distinct filter value the browse UI offers, in one request.
 *
 * Scoped to the caller's own hands, because `hands_facets()` is
 * `security invoker` and every subquery in it reads `public.hands`. That is the
 * behaviour the UI wants anyway: a site or a hero you have never played is not
 * a useful thing to offer as a filter.
 */
export async function fetchHandFacets(): Promise<HandFacets> {
  if (!(await currentUserId())) {
    return NO_FACETS;
  }
  const payload = await rpc<Record<string, unknown>>("hands_facets");
  return {
    total: Number(payload.total ?? 0),
    sites: (payload.sites ?? []) as HandFacets["sites"],
    heroes: (payload.heroes ?? []) as HandFacets["heroes"],
    tables: (payload.tables ?? []) as string[],
    stakes: (payload.stakes ?? []) as HandFacets["stakes"],
    variants: (payload.variants ?? []) as string[],
    limitTypes: (payload.limitTypes ?? []) as string[],
    gameFormats: (payload.gameFormats ?? []) as HandFacets["gameFormats"],
    heroHandClasses: (payload.heroHandClasses ?? []) as string[],
    streets: (payload.streets ?? []) as StreetReached[],
    heroPositions: (payload.heroPositions ?? []) as HandFacets["heroPositions"],
    showdownPositions: (payload.showdownPositions ?? []) as HandFacets["showdownPositions"],
    anonymizations: (payload.anonymizations ?? []) as HandFacets["anonymizations"],
    playedAtRange: (payload.playedAtRange ?? { min: null, max: null }) as HandFacets["playedAtRange"],
    unparsedTotal: Number(payload.unparsedTotal ?? 0),
  };
}

/**
 * How many hands are stored. Returns 0 rather than throwing when the database
 * is not configured, because this is used for a passive status badge.
 */
export async function countHands(): Promise<number> {
  if (!isDatabaseConfigured) {
    return 0;
  }
  try {
    const facets = await fetchHandFacets();
    return facets.total;
  } catch {
    return 0;
  }
}

/** One page of hands for a single filter-free listing; a thin `searchHands` alias. */
export async function listRecentHands(limit = 25): Promise<HandSummary[]> {
  const { rows } = await searchHands({ sort: "played_desc" }, { offset: 0, limit });
  return rows;
}

/* -------------------------------------------------------------- filters - */

export interface FilterFormOptions {
  /**
   * Minor units per display unit for the `minPot` box, so "25" means $25 on a
   * cash table and 25 chips at a tournament. Defaults to 100 (cents).
   */
  minorUnits?: number;
}

/**
 * Turns the filter bar's raw strings into server-side filters.
 *
 * Unparseable card input deliberately produces a filter that matches nothing
 * rather than one that matches everything: typing "asdf" into the hero box
 * should not silently show you every hand you own.
 */
export function handFiltersFromForm(
  form: HandFilterForm,
  options: FilterFormOptions = {},
): HandFilters {
  const minorUnits = options.minorUnits ?? 100;
  const filters: HandFilters = { sort: form.sort };

  const board = extractCards(form.board);
  if (board.length > 0) {
    filters.board = board;
  }

  const hero = resolveHeroQuery(form.heroCards);
  if (hero.kind === "class") {
    filters.heroHandClasses = hero.values;
  } else if (hero.kind === "cards") {
    filters.heroCards = hero.values;
  } else if (form.heroCards.trim()) {
    filters.heroHandClasses = ["__no_match__"];
  }

  const player = form.player.trim();
  if (player) {
    filters.player = player;
  }

  const tableName = form.tableName.trim();
  if (tableName) {
    filters.tableName = tableName;
  }

  const site = form.site.trim();
  if (site) {
    filters.site = site.toLowerCase();
  }

  if (form.showdownOnly) {
    filters.showdownOnly = true;
  }
  if (form.heroWonOnly) {
    filters.heroWonOnly = true;
  }

  const minPot = Number(form.minPot);
  if (form.minPot.trim() && Number.isFinite(minPot)) {
    filters.minPot = Math.round(minPot * minorUnits);
  }

  if (form.fromDate) {
    filters.from = new Date(`${form.fromDate}T00:00:00`).toISOString();
  }
  if (form.toDate) {
    filters.to = new Date(`${form.toDate}T23:59:59.999`).toISOString();
  }

  return filters;
}
