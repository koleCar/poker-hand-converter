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
 * 3. **Nothing can be updated or deleted from the client.** The schema grants
 *    insert-and-read only. Rows that must change (failure counters, share
 *    views) change inside `security definer` functions that can touch nothing
 *    else. The reasoning is written out in `docs/DATABASE.md` and in the
 *    migration's SQL comments.
 * 4. **A hand belongs to exactly one account.** Every read and every write is
 *    scoped to `auth.uid()` by RLS, not by anything in this directory — there
 *    is no client-side filter to forget and no query that could ask for
 *    somebody else's hands. Writes throw `SignInRequiredError` without sending
 *    anything when there is no session; reads return empty. The one deliberate
 *    exception is `resolveShare()`, which works for anyone holding the slug.
 */

export {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  DatabaseNotConfiguredError,
  DatabaseRpcError,
  SIGN_IN_REQUIRED_MESSAGE,
  SignInRequiredError,
  isDatabaseConfigured,
  isMissingSchemaError,
} from "./client";

export {
  emptyStatsGraph,
  emptyStatsSummary,
  fetchStatsBreakdown,
  fetchStatsCoverage,
  fetchStatsGraph,
  fetchStatsOpponents,
  fetchStatsSessions,
  myPlayerNotes,
  setPlayerNote,
  fetchStatsSummary,
  pruneVillainStats,
  rebuildStats,
  setVillainRowsEnabled,
  handStatsRows,
  saveHandStats,
  villainRowsEnabled,
  type HandStatsInsert,
  type BreakdownGroup,
  type BreakdownRow,
  type MoneyUnitState,
  type OpponentFilters,
  type OpponentRow,
  type PlayerNote,
  type StatsSession,
  type StatsSessions,
  type RebuildProgress,
  type SaveHandStatsResult,
  type StatsFilters,
  type StatsGraph,
  type StatsOpponents,
  type StatsGraphBucket,
  type StakeVolume,
  type StatsBreakdown,
  type StatsCoverage,
  type StatsSummary,
} from "./stats";

export {
  ANALYSIS_SORTS,
  fetchAnalysisBreakdown,
  fetchAnalysisCoverage,
  fetchAnalysisHands,
  fetchAnalysisOverview,
  fetchHandAnalysis,
  analyseHandNow,
  preflopCharts,
  runAnalysis,
  studyRiver,
  type AnalysisBreakdownGroup,
  type AnalysisBreakdownRow,
  type AnalysisCoverage,
  type AnalysisFilters,
  type AnalysisHandDecision,
  type AnalysisHandRow,
  type AnalysisHandsPage,
  type AnalysisOverview,
  type AnalysisProgress,
  type AnalysisSort,
  type FlagCount,
  type StreetSummary,
} from "./analysis";

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

export {
  myPublishedHandIds,
  publishErrorMessage,
  publishHand,
  unpublishHand,
  type PublishMode,
  type PublishResult,
} from "./publishing";

export {
  fetchMyProfile,
  setUsername,
  usernameErrorMessage,
  USERNAME_PATTERN,
  type MyProfile,
  type ProfileRole,
  type UsernameChange,
} from "./profiles";

export {
  anonymizationNote,
  detectAnonymization,
  hasUsablePlayerNames,
} from "./anonymization";

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
  type PositionLabel,
  type RecordFailuresResult,
  type SiteAnonymization,
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
