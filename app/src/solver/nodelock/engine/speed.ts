/**
 * How hard a nodelock solve works this computer (#409): Slow, Medium or
 * Fast, picked under the Solve button and kept on this computer. Medium
 * unless the user picked another.
 *
 * | Speed  | Threads           | A flop lock's storage (native engine)                          |
 * |--------|-------------------|----------------------------------------------------------------|
 * | Slow   | half the cores    | 16-bit, ~1.1 GB                                                |
 * | Medium | all cores but one | 16-bit, ~1.1 GB                                                |
 * | Fast   | every core        | float32 when it fits two fifths of the memory (~3.1 GB), else 16-bit |
 *
 * The worker engine always stores 16-bit; its memory grows with its workers
 * (each holds its part of the turn subtrees). A turn or river lock is small
 * whatever the speed. Changing the speed starts the next solve cold (the
 * kept solver was built for the old threads and storage).
 */

export type SolveSpeed = "slow" | "medium" | "fast";

export const SOLVE_SPEEDS: readonly SolveSpeed[] = ["slow", "medium", "fast"];

export const DEFAULT_SPEED: SolveSpeed = "medium";

/** The threads a solve at `speed` uses on `cores` cores. */
export function speedThreads(speed: SolveSpeed, cores: number): number {
  const all = Math.max(1, Math.floor(cores) || 1);
  switch (speed) {
    case "slow":
      return Math.max(1, Math.floor(all / 2));
    case "medium":
      return Math.max(1, all - 1);
    case "fast":
      return all;
  }
}

/** A flop lock's storage on the native engine: 16-bit, or null for its default (float32 when it fits the memory, else 16-bit). */
export function speedStorage(speed: SolveSpeed): "i16" | null {
  return speed === "fast" ? null : "i16";
}

const STORAGE_KEY = "rail.nodelock.speed";

const isSpeed = (value: unknown): value is SolveSpeed => SOLVE_SPEEDS.includes(value as SolveSpeed);

/** The speed picked on this computer; Medium when none was. */
export function loadSpeed(): SolveSpeed {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isSpeed(value) ? value : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
}

export function saveSpeed(speed: SolveSpeed): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, speed);
  } catch {
    // Not kept: the next editor opens on Medium.
  }
}
