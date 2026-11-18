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
  lockHash,
  lockPathOf,
  NodelockError,
  nodelockHeader,
  SplitCoordinator,
  SplitPart,
  splitCards,
  type FlopChunk,
  type FlopSpot,
  type LockSet,
  type NodeLockSpec,
  type LockEarlier,
  type RunResult,
  type SplitSpec,
  type SplitStep,
  type UnitValues,
} from "@rail/web-lib/solver";
export {
  checkBaseline,
  NODELOCK_WARM_ITERATION,
  nodelockFlopRun,
  nodelockSpotOf,
  solveNodelock,
  type NodelockSolve,
  type NodelockSpot,
} from "@rail/web-lib/analysis/nodelock";
export { loadChartSet } from "@rail/web-lib/charts";
