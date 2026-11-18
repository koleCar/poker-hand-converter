/**
 * The request the native engine's `nodelock_solve_start` takes
 * (`rail_solver::nodelock::NodelockRequest`), built from the reference's game
 * (`nodelockSpotOf`). Pure: no Tauri, no chart loading, so the tests build
 * the very request the app sends (`tests/test/appNodelockNative.test.ts`,
 * and the app crate's command test reads one as a fixture).
 *
 * Floats cross exactly: the ranges and the library chunk as base64 of their
 * bytes, where JSON numbers need not parse back to the same bits.
 */
import { LIVE_TURN, nodelockFlopRun, nodelockHeader, type FlopChunk, type LockSet, type NodelockSpot } from "./door";

/** Base64 of bytes (`btoa` over 32 KB slices: no argument-count limit). */
export function base64(bytes: Uint8Array): string {
  let text = "";
  for (let k = 0; k < bytes.length; k += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  }
  return btoa(text);
}

/** A 1,326-weight range as the engine reads it exactly: little-endian f64 bytes, base64. */
export const rangeBits = (range: unknown): string => base64(new Uint8Array(Float64Array.from(range as ArrayLike<number>).buffer));

export interface NativeRequest {
  /** The game: `nodelockSpotOf`'s spot, its ranges as `rangeBits`. */
  spot: Record<string, unknown> & { ranges: [string, string] };
  lockSet: LockSet;
  /** Base64 of the chunk the lock is solved on (a flop lock's earlier nodes): the library's, or a based lock's base (§7.4); null for a turn or river lock, whose baseline the engine solves. */
  baseline: string | null;
  /** The result chunk's header (`nodelockHeader`, `lockHash` in it), as `JSON.stringify` writes it. */
  header: string;
  options: { maxIterations: number | undefined; targetPct: number | undefined; checkFrom: number | undefined; checkEvery: number | undefined; dcfr: { alpha: number; beta: number; gamma: number } };
}

/**
 * The native request of a lock on `spot` (`nodelockSpotOf(lockSet, chunk,
 * charts)`), solved on `baseline` (its bytes, `chunk` decoded): the library
 * chunk, or for a based lock (`lockSet.base`, §7.4) its base lock's result.
 * The header names the base (`baseHash`).
 */
export function nativeRequestOf(lockSet: LockSet, baseline: Uint8Array, chunk: FlopChunk, spot: NodelockSpot, maxIterations?: number): NativeRequest {
  const header = JSON.stringify(nodelockHeader(chunk.header, lockSet));
  const game = { ...spot.spot, ranges: [rangeBits(spot.spot.ranges[0]), rangeBits(spot.spot.ranges[1])] as [string, string] };
  if (spot.street === "flop") {
    const run = nodelockFlopRun(lockSet, maxIterations);
    return {
      spot: game,
      lockSet,
      baseline: base64(baseline),
      header,
      options: { maxIterations: run.maxIterations, targetPct: run.targetExploitability, checkFrom: run.checkFrom, checkEvery: run.checkEvery, dcfr: run.dcfr },
    };
  }
  return {
    spot: game,
    lockSet,
    // A turn lock's earlier nodes keep the unlocked live turn, which the engine solves first.
    baseline: null,
    header,
    options: {
      maxIterations: maxIterations ?? LIVE_TURN.maxIterations,
      targetPct: lockSet.targetPct,
      checkFrom: LIVE_TURN.checkFrom,
      checkEvery: LIVE_TURN.checkEvery,
      dcfr: LIVE_TURN.dcfr,
    },
  };
}
