/**
 * The database layer.
 *
 * One import site for everything that touches Supabase. Three rules hold
 * everywhere below:
 *
 * 1. **The app works without a database.** Check `isDatabaseConfigured` before
 *    offering a feature; every call throws `DatabaseNotConfiguredError` with a
 *    readable message if you forget, rather than hanging or returning empty.
 * 2. **Money is integer minor units**, exactly as in PHF. Render with
 *    `handUnit(row)` plus `formatAmount()` from `lib/phf/types`.
 * 3. **Nothing can be updated or deleted from the client.** There is no login,
 *    the anon key is public, and the schema grants insert-and-read only. Rows
 *    that must change (failure counters, share views) change inside
 *    `security definer` functions that can touch nothing else. The reasoning is
 *    written out in `docs/DATABASE.md` and in the migration's SQL comments.
 */

export {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  DatabaseNotConfiguredError,
  isDatabaseConfigured,
} from "./client";

export {
  countHands,
  fetchHandFacets,
  findHandId,
  getHand,
  handFiltersFromForm,
  handKeyOf,
  listRecentHands,
  saveHand,
  saveHands,
  searchHands,
  type FilterFormOptions,
  type HandPage,
  type SaveHandInput,
  type SaveHandsOptions,
} from "./hands";

export {
  fetchUnparsedRawText,
  fetchUnparsedSummary,
  listUnparsedHands,
  recordConversionFailures,
  type UnparsedQuery,
} from "./failures";

export { createShare, resolveShare } from "./shares";

export { handInsertFromPhf, type HandInsert } from "./mapping";

export {
  EMPTY_HAND_FILTER_FORM,
  handUnit,
  type ConversionStage,
  type CreateShareInput,
  type FacetCount,
  type GameFormat,
  type HandFacets,
  type HandFilterForm,
  type HandFilters,
  type HandRecord,
  type HandSearchResult,
  type HandSortKey,
  type HandSummary,
  type RecordFailuresResult,
  type ResolvedShare,
  type SaveHandsResult,
  type ShareRef,
  type StakeFacet,
  type StreetReached,
  type UnparsedGap,
  type UnparsedHand,
  type UnparsedStatus,
  type UnparsedSummary,
} from "./types";
