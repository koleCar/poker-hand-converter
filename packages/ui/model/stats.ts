/**
 * What a displayed statistic carries: the R2.4 definitions
 * (`config/stats/`, `frontend/src/lib/stats/display.ts`) and the R2.5
 * reliability (`reliability.ts`). Types only - the package shows values, it
 * never computes them (guideline §14; `tests/test/statDisplay.test.ts` scans
 * this package too). The web computes a `Shown` with `showStat`, the desktop
 * app gets the same shape from `rail_stats` over IPC. See `phf.ts` for why
 * `model/` exists.
 */
export type {
  DisplayStat,
  Shown,
  StatDefinition,
  StatGroup,
  StatReliability,
  StatText,
  StatTone,
  StatUnit,
} from "../../../frontend/src/lib/stats/display";
export type { RateInterval, Reliability } from "../../../frontend/src/lib/stats/reliability";
