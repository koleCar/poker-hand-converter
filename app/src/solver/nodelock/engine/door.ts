/**
 * The nodelock engine's door to the web's library (`@rail/web-lib`, used in
 * place as `src/analysis/library.ts` and `src/solver/door.ts` use it): the
 * lock model, the split solve and the locked solve (`docs/NODELOCK.md`
 * §1–2.4). Pure TypeScript, so the engine's workers bundle no React.
 * ESLint keeps every other app file away from the alias.
 */
export {
  applyNodelock,
  chunkBaseline,
  decodeChunk,
  driveAsync,
  encodeChunk,
  LIVE_TURN,
  lockGameStreet,
  rangeDiff,
  rangeLocksOf,
  rangesDiffer,
  rangesHash,
  rangesWith,
  readLockSet,
  withLockRanges,
  lockHash,
  lockPathOf,
  NodelockError,
  nodelockHeader,
  SplitCoordinator,
  SplitPart,
  splitCards,
  splitLockPath,
  type FlopChunk,
  type FlopSpot,
  type LockBase,
  type LockSet,
  type NodeLockSpec,
  type LockEarlier,
  type RangeLock,
  type RunResult,
  type SplitSpec,
  type SplitStep,
  type UnitValues,
} from "@rail/web-lib/solver";
export {
  checkBase,
  checkBaseline,
  NODELOCK_WARM_ITERATION,
  nodelockFlopRun,
  nodelockSpotOf,
  solveNodelock,
  type NodelockSolve,
  type NodelockSpot,
} from "@rail/web-lib/analysis/nodelock";
export { loadChartSet } from "@rail/web-lib/charts";
