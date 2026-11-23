/**
 * The Analytics stat checker (docs/ANALYTICS.md Step 3,
 * `web/src/lib/stats/checker.ts`) and the catalogue it judges against
 * (`analytics.ts`): the shapes the Analytics screens show, and the pure
 * function that makes them from a `CheckerSource`'s sums, the same on both
 * surfaces (the desktop's Rust twin, `rail_stats::checker`, gives the same
 * output). See `phf.ts` for why `model/` exists.
 */
export * from "../../../web/src/lib/stats/checker";
export { ANALYTICS } from "../../../web/src/lib/stats/analytics";
export type {
  ActionClass,
  AnalyticsText,
  Catalogue,
  CatalogueStat,
  HandClassDef,
  SizeBucketDef,
  StatGroupDef,
} from "../../../web/src/lib/stats/analytics";
