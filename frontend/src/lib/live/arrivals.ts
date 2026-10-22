/**
 * Live arrival on the web (Rail R1.10): when to refresh.
 *
 * The database bumps one row per account (`hand_arrivals`) once per insert
 * statement on `hands` - one desktop `ingest_hands` call (up to 500 hands) or
 * one web `save_hands` call - and Realtime delivers that change to the
 * account's open tabs. This module decides when those signals become a
 * refetch. Pure: no framework, no Supabase, timers injected, so it is tested
 * under plain Node (`tests/test/liveArrivals.test.ts`).
 *
 * The rules:
 *
 * - **Debounce.** A refresh runs once the signals have been quiet for
 *   `quietMs` (1.5 s): a desktop backfill sends a batch every second or two,
 *   and the page must refetch once for the burst, never once per batch or
 *   per hand.
 * - **But not forever.** A burst that never goes quiet (a 500 000-hand
 *   backfill takes over half an hour) still refreshes after `maxWaitMs`
 *   (5 s) - and every refresh forced that way doubles the next wait, up to
 *   `maxWaitCapMs` (30 s), so a long backfill costs the page a refetch every
 *   30 s rather than every 5. The first quiet flush resets it.
 * - **Hidden tabs do nothing.** While the page is hidden the signals are
 *   only counted; the one refresh they add up to runs when it is shown again.
 * - **A resync is a signal too.** After the socket reconnects, events may
 *   have been missed; the hook pushes one with an unknown count.
 */

export type ArrivalOrigin = "web" | "desktop";

/** One change of the account's `hand_arrivals` row, or a resync. */
export interface ArrivalSignal {
  /** Hands the statement added; null for a resync (count unknown). */
  hands: number | null;
  origin: ArrivalOrigin | null;
}

/** What one refresh covers. */
export interface ArrivalBatch {
  /** Increases by one per flush; a dependency for effects. */
  seq: number;
  /** Hands the signals in this batch reported (a resync adds none). */
  hands: number;
  /** At least one signal came from the desktop app. */
  desktop: boolean;
  /** Of `hands`, those the desktop app's signals reported (R4.3's "desktop app syncing"). */
  desktopHands: number;
  /** At least one signal was a resync: the count may be short. */
  resync: boolean;
}

export interface ArrivalTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

export interface ArrivalBatcherOptions {
  onFlush: (batch: ArrivalBatch) => void;
  quietMs?: number;
  maxWaitMs?: number;
  maxWaitCapMs?: number;
  /** Whether the page starts hidden. */
  hidden?: boolean;
  timers?: ArrivalTimers;
}

export interface ArrivalBatcher {
  push(signal: ArrivalSignal): void;
  setHidden(hidden: boolean): void;
  /** Stops for good: pending signals are dropped, nothing flushes again. */
  dispose(): void;
}

export const ARRIVAL_QUIET_MS = 1500;
export const ARRIVAL_MAX_WAIT_MS = 5000;
export const ARRIVAL_MAX_WAIT_CAP_MS = 30000;

const realTimers: ArrivalTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createArrivalBatcher(options: ArrivalBatcherOptions): ArrivalBatcher {
  const quietMs = options.quietMs ?? ARRIVAL_QUIET_MS;
  const baseMaxWait = options.maxWaitMs ?? ARRIVAL_MAX_WAIT_MS;
  const capMaxWait = Math.max(baseMaxWait, options.maxWaitCapMs ?? ARRIVAL_MAX_WAIT_CAP_MS);
  const timers = options.timers ?? realTimers;

  let hidden = options.hidden ?? false;
  let disposed = false;
  let seq = 0;
  let maxWait = baseMaxWait;

  let pending = false;
  let firstAt = 0;
  let hands = 0;
  let desktopHands = 0;
  let desktop = false;
  let resync = false;
  let timer: unknown = null;

  function cancel() {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
  }

  function flush(forced: boolean) {
    cancel();
    if (!pending || disposed) {
      return;
    }
    // A flush forced by the max wait means the burst is still going on.
    maxWait = forced ? Math.min(capMaxWait, maxWait * 2) : baseMaxWait;
    seq += 1;
    const batch: ArrivalBatch = { seq, hands, desktop, desktopHands, resync };
    pending = false;
    hands = 0;
    desktopHands = 0;
    desktop = false;
    resync = false;
    options.onFlush(batch);
  }

  function schedule() {
    cancel();
    if (!pending || hidden || disposed) {
      return;
    }
    const untilMax = firstAt + maxWait - timers.now();
    if (untilMax <= quietMs) {
      timer = timers.set(() => flush(true), Math.max(0, untilMax));
    } else {
      timer = timers.set(() => flush(false), quietMs);
    }
  }

  return {
    push(signal) {
      if (disposed) {
        return;
      }
      if (!pending) {
        pending = true;
        firstAt = timers.now();
      }
      if (signal.hands === null) {
        resync = true;
      } else if (Number.isFinite(signal.hands) && signal.hands > 0) {
        hands += Math.floor(signal.hands);
        if (signal.origin === "desktop") {
          desktopHands += Math.floor(signal.hands);
        }
      }
      if (signal.origin === "desktop") {
        desktop = true;
      }
      schedule();
    },
    setHidden(next) {
      if (disposed || next === hidden) {
        return;
      }
      hidden = next;
      if (hidden) {
        cancel();
      } else if (pending) {
        // Shown again: what piled up while hidden is one refresh, now.
        flush(false);
      }
    },
    dispose() {
      disposed = true;
      pending = false;
      cancel();
    },
  };
}

/**
 * Reads a Realtime change of `hand_arrivals` into a signal.
 *
 * Defensive on purpose: the payload is the database's row as JSON, and a
 * shape this build does not expect still means "something arrived".
 */
export function arrivalSignalFromRow(row: unknown): ArrivalSignal {
  const record = (row ?? {}) as { hands?: unknown; origin?: unknown };
  const count = Number(record.hands);
  return {
    hands: Number.isFinite(count) && count > 0 ? count : null,
    origin: record.origin === "desktop" || record.origin === "web" ? record.origin : null,
  };
}

/**
 * "Desktop app syncing: 12 500 hands so far" (R4.3), from the batches above.
 *
 * The app does not announce a sync's start or end; its rows do. Desktop
 * hands accumulate while batches keep coming; a sync is over once none has
 * come for `quietMs` (2 minutes - the app sends a batch every few seconds
 * while it has work), and the next batch after that starts a new count.
 */
export const DESKTOP_SYNC_QUIET_MS = 2 * 60 * 1000;

export interface DesktopSyncState {
  /** Desktop hands since this sync's first batch reached the page. */
  hands: number;
  /** The viewer's clock at the last desktop batch. */
  lastAt: number;
}

export function noteDesktopBatch(
  current: DesktopSyncState | null,
  batch: ArrivalBatch,
  now: number,
  quietMs = DESKTOP_SYNC_QUIET_MS,
): DesktopSyncState | null {
  if (batch.desktopHands <= 0) {
    return current;
  }
  const running = current !== null && now - current.lastAt < quietMs;
  return { hands: (running ? current.hands : 0) + batch.desktopHands, lastAt: now };
}

/** The sync to show at `now`, or null once it has gone quiet. */
export function activeDesktopSync(
  current: DesktopSyncState | null,
  now: number,
  quietMs = DESKTOP_SYNC_QUIET_MS,
): DesktopSyncState | null {
  return current !== null && now - current.lastAt < quietMs ? current : null;
}
