/**
 * The browser's side of the one pass (docs/POOL.md P1). Pages never derive
 * or count: hands are worked out on the server when they arrive
 * (`derive_queue`). From here a page can only:
 *
 * - ask the server to work out the caller's queued hands now
 *   ({@link deriveNow}, `POST /api/derive`) - the upload does, right after
 *   the hands are stored, and so does turning opponents' statistics on;
 * - read how many are still being processed ({@link fetchDerivePending},
 *   `derive_pending`: one counter row);
 * - read and set the account's opponents' statistics
 *   ({@link useOpponentStats}, {@link setOpponentStats}: `derive_options`,
 *   formerly this browser's `localStorage`).
 */

import { useEffect, useSyncExternalStore } from "react";
import { currentUserId, rpc } from "./client";

export interface DeriveProgress {
  /** Hands worked out by this run. */
  processed: number;
  /** The caller's hands still in the queue. */
  pending: number;
}

/** In flight: a second caller joins it instead of starting another. */
let running: Promise<DeriveProgress> | null = null;

/**
 * Works out the caller's queued hands on the server, slice by slice, until
 * the queue is empty (or a slice makes no progress: the scheduled worker
 * holds those rows). Never rejects for a signed-out caller; a failed call
 * rejects with the server's message.
 */
export function deriveNow(onProgress?: (progress: DeriveProgress) => void): Promise<DeriveProgress> {
  if (running) {
    if (onProgress) void running.then(onProgress, () => undefined);
    return running;
  }
  const run = (async () => {
    const total: DeriveProgress = { processed: 0, pending: 0 };
    if (!(await currentUserId())) return total;
    // Bounded: 2000 slices of 8 s is far beyond any library.
    for (let slice = 0; slice < 2000; slice += 1) {
      const response = await fetch("/api/derive", { method: "POST", headers: { "content-type": "application/json" } });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : `Processing your hands failed (${response.status}).`);
      }
      const processed = Number(payload.processed) || 0;
      total.processed += processed;
      total.pending = Number(payload.pending) || 0;
      onProgress?.({ ...total });
      if (payload.done === true || processed === 0) break;
    }
    return total;
  })();
  running = run;
  void run.finally(() => {
    if (running === run) running = null;
  }).catch(() => undefined);
  return run;
}

/** The caller's hands still being processed (0 when signed out or unknown). */
export async function fetchDerivePending(): Promise<number> {
  if (!(await currentUserId())) return 0;
  return Number(await rpc<number>("derive_pending").catch(() => 0)) || 0;
}

/* ------------------------------------------------- opponents' statistics - */

/** The account's setting: null until read. */
let opponents: { user: string; on: boolean } | null = null;
let loading: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the account's setting once per account (`derive_villains`). */
function load(user: string): void {
  if ((opponents && opponents.user === user) || loading === user) return;
  loading = user;
  rpc<boolean>("derive_villains")
    .then((on) => {
      opponents = { user, on: on === true };
    })
    .catch(() => {
      opponents = { user, on: false };
    })
    .finally(() => {
      if (loading === user) loading = null;
      emit();
    });
}

/**
 * Whether the signed-in account derives its opponents' statistics: null while
 * it is read (and for nobody signed in).
 */
export function useOpponentStats(userId: string | null): boolean | null {
  useEffect(() => {
    if (userId) load(userId);
  }, [userId]);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => opponents,
    () => null,
  );
  return userId && snapshot && snapshot.user === userId ? snapshot.on : null;
}

/**
 * Turns the account's opponents' statistics on or off. On queues every hand
 * for its opponents' rows (the caller then runs {@link deriveNow}); off only
 * records it (the rows go with `pruneVillainStats`, as before). How many hands
 * were queued.
 */
export async function setOpponentStats(on: boolean): Promise<number> {
  const user = await currentUserId();
  const result = await rpc<{ queued?: number } | null>("derive_villains_set", { p_on: on });
  if (user) {
    opponents = { user, on };
    emit();
  }
  return Number(result?.queued) || 0;
}
