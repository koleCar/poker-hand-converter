/**
 * Saving a bulk conversion while it runs (R4.2): chunked, retried, resumable.
 *
 * The converter used to keep every converted hand and save them all when the
 * run ended. At a desktop export's scale that is the whole library in the
 * tab's memory first, and one network blip from losing the lot. Here hands
 * are saved **as they are converted**:
 *
 *  * **A bounded queue.** Batches from the worker go into a queue of rows; the
 *    worker is acknowledged only while the queue holds fewer than
 *    `maxQueuedHands` (and the kept originals fewer than
 *    `maxQueuedOriginalBytes`), so conversion waits for the network, never
 *    the other way round, and the tab holds at most that many hands.
 *  * **Chunked calls.** One call at a time, of at most `maxHandsPerCall` rows
 *    and `maxBytesPerCall` bytes (`ingest_hands` takes 500 and 8 MiB; the
 *    smaller chunk keeps each call well inside PostgREST's statement timeout).
 *  * **Retries.** A transient failure (no answer, a timeout, a 5xx) is retried
 *    with exponential backoff and jitter; after `retry.attempts` the upload
 *    pauses with everything still queued and the page offers "Try again".
 *    The account's 10-minute budget spent: wait and send again. Its daily
 *    budget, or the session gone: pause. A call the server refuses outright
 *    is a bug, not a reason to stop: its rows count as refused.
 *  * **Dedupe.** The server's: `on conflict (owner_id, hand_key) do nothing`,
 *    reported per row. Re-uploading a file inserts nothing and says so.
 *  * **The Free cap** (R6.4). Once paid plans are enforced, the server
 *    refuses a call that would put a Free library over its cap *whole*
 *    (`PT402`, R6.2) and says how much room is left. The saver then cuts its
 *    calls to that room, so every hand that fits is saved, and pauses with
 *    `cap` when nothing more fits ("Try again" after an upgrade). Any other
 *    plan refusal pauses with `plan`. The server stays the gate: nothing
 *    here counts hands itself.
 *  * **Resume.** Every acknowledged call advances the manifest
 *    (`uploadManifest.ts`): per source, the batches stored and, once all are
 *    (and its original, when kept), done. A later drop of the same files
 *    skips what is recorded.
 *
 * Nothing here knows about React; `ConverterTab` drives it and renders
 * {@link SaveProgress}.
 */

import type { ConversionFailure } from "../../lib/phf/detect";
import type { PhfHand } from "../../lib/phf/types";
import { handKeyOf } from "../../lib/db/mapping";
import { UploadError, type IngestRow, type UploadApi } from "../../lib/db/upload";
import { allowanceOf } from "../../lib/entitlements/planRefusal";
import type { SourceInfo } from "./bulkRun";
import type { StreamBatch } from "./pipeline";
import type { ManifestStore, UploadManifest } from "./uploadManifest";

export type SaveStateName =
  /** Sending, or waiting for the converter. */
  | "saving"
  /** A transient failure; the next attempt is at `retryAt`. */
  | "retrying"
  /** The account's 10-minute budget is spent; sending again at `retryAt`. */
  | "waiting-budget"
  /** Stopped with work queued; see `pauseReason`. `resume()` continues. */
  | "paused"
  /** Everything handed over is stored (or refused). */
  | "done"
  /** `cancel()`: stopped for good. */
  | "cancelled";

/**
 * Why a save stopped. (R6.4) `cap`: the library is full on the Free plan -
 * everything that fit was saved; `plan`: the plan refused the save for
 * another reason. Both resume after an upgrade ("Try again").
 */
export type PauseReason = "offline" | "signed-out" | "day-budget" | "cap" | "plan";

export interface SaveProgress {
  state: SaveStateName;
  pauseReason: PauseReason | null;
  /** Epoch ms of the next attempt while retrying or waiting. */
  retryAt: number | null;
  /** Hands handed to the saver. */
  received: number;
  /** Hands the server answered for. */
  sent: number;
  inserted: number;
  duplicates: number;
  refused: number;
  /** Refusals by reason code (`ingest_hands`' `reason`, or `call` for a refused call). */
  refusedReasons: Record<string, number>;
  /** Hands waiting in the tab. */
  queued: number;
  sourcesDone: number;
  originalsStored: number;
  originalsBytes: number;
  originalsFailed: number;
  /** What the failure corpus made of the refused hands sent so far; null before any. */
  failuresRecorded: { created: number; updated: number } | null;
  /**
   * (R6.4) The Free hand cap was met: its size and the hands stored before
   * the refused call. Null until then (and after a resume).
   */
  cap: { cap: number; stored: number } | null;
  /** (R6.4) Calls were cut to what still fit under the cap. */
  trimmed: boolean;
  /** The last failure's message, technical. */
  lastError: string | null;
}

export interface SaverOptions {
  api: UploadApi;
  /** Null when the browser has no IndexedDB: the upload works, without resuming. */
  store: ManifestStore | null;
  manifest: UploadManifest;
  /** `<uid>/<upload id>/` is prefixed to each original's path. */
  userId: string;
  /** Called with how many more batches the worker may convert. */
  ack(batches: number): void;
  onChange?(progress: SaveProgress): void;
  /** Once, when everything handed over is stored and the input is closed. */
  onDone?(progress: SaveProgress): void;
  maxHandsPerCall?: number;
  maxBytesPerCall?: number;
  maxQueuedHands?: number;
  maxQueuedOriginalBytes?: number;
  /** Failures recorded to the corpus per upload, at most. */
  maxFailures?: number;
  retry?: { baseMs: number; maxMs: number; attempts: number };
  /** Wait after a spent 10-minute budget, and how many such waits before pausing. */
  budgetWaitMs?: number;
  budgetWaits?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  random?(): number;
}

type Item =
  | { kind: "row"; key: string; row: IngestRow; bytes: number }
  | { kind: "mark"; key: string; batches?: number; done?: boolean };

interface Original {
  key: string;
  path: string;
  blob: Blob;
}

export interface BulkSaver {
  /** A source was read; its original (if kept) joins the queue. */
  addSource(source: SourceInfo): void;
  /** One converted batch: its hands join the queue. */
  addBatch(batch: StreamBatch): void;
  /** All of a source's batches were handed over. */
  endSource(key: string): void;
  /** Hands held in the tab, not converted by this run (the held results of a guest). */
  addHands(hands: PhfHand[]): void;
  /** No more input; `drained` resolves once the queue is empty. */
  close(): void;
  /** After a pause: try again. */
  resume(): void;
  /** Stop for good; queued work is dropped (the manifest keeps what is stored). */
  cancel(): void;
  progress(): SaveProgress;
  /** Resolves when the saver is done, cancelled or paused. */
  idle(): Promise<SaveProgress>;
}

/** Rows a call may carry, and bytes. */
export const MAX_HANDS_PER_CALL = 250;
export const MAX_BYTES_PER_CALL = 3_000_000;
/** Hands queued in the tab before the worker is held back. */
export const MAX_QUEUED_HANDS = 1_500;
export const MAX_QUEUED_ORIGINAL_BYTES = 32 * 1024 * 1024;
export const MAX_FAILURES_PER_UPLOAD = 2_000;
const FAILURES_PER_CALL = 200;

/** The PHF as `ingest_hands` takes it: no original text (A2, Q4). */
export function ingestRowOf(hand: PhfHand): IngestRow {
  return {
    hand_key: handKeyOf(hand),
    phf: { ...hand, meta: { ...hand.meta, rawText: "" } },
  };
}

export function createBulkSaver(options: SaverOptions): BulkSaver {
  const api = options.api;
  const store = options.store;
  const manifest = options.manifest;
  const maxHands = options.maxHandsPerCall ?? MAX_HANDS_PER_CALL;
  const maxBytes = options.maxBytesPerCall ?? MAX_BYTES_PER_CALL;
  const maxQueued = options.maxQueuedHands ?? MAX_QUEUED_HANDS;
  const maxOriginalBytes = options.maxQueuedOriginalBytes ?? MAX_QUEUED_ORIGINAL_BYTES;
  const maxFailures = options.maxFailures ?? MAX_FAILURES_PER_UPLOAD;
  const retry = options.retry ?? { baseMs: 1_000, maxMs: 30_000, attempts: 6 };
  const budgetWaitMs = options.budgetWaitMs ?? 60_000;
  const budgetWaits = options.budgetWaits ?? 15;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const prefix = `${options.userId}/${manifest.id}/`;

  const queue: Item[] = [];
  const originals: Original[] = [];
  const failures: ConversionFailure[] = [];
  let failuresTaken = 0;
  let queuedHands = 0;
  let queuedOriginalBytes = 0;
  /** Batches received from the worker and not yet acknowledged. */
  let owed = 0;
  /** Sources whose original is not stored yet, and those already ended. */
  const originalPending = new Set<string>();
  const endedWaitingOriginal = new Set<string>();

  let source: string | null = null;
  let closed = false;
  let running = false;
  let wake: (() => void) | null = null;
  const idleWaiters: Array<(p: SaveProgress) => void> = [];

  const state: SaveProgress = {
    state: "saving",
    pauseReason: null,
    retryAt: null,
    received: 0,
    sent: 0,
    inserted: manifest.counts.inserted,
    duplicates: manifest.counts.duplicates,
    refused: manifest.counts.refused,
    refusedReasons: {},
    queued: 0,
    sourcesDone: manifest.counts.sourcesDone,
    originalsStored: manifest.counts.originalsStored,
    originalsBytes: 0,
    originalsFailed: 0,
    failuresRecorded: null,
    cap: null,
    trimmed: false,
    lastError: null,
  };
  /**
   * (R6.4) Rows the next call may carry while the Free cap is near: the
   * server refuses a save over the cap *whole* (R6.2), so after its refusal
   * the calls are cut to the room it reported and what fits is saved; null
   * = the usual size.
   */
  let callLimit: number | null = null;

  const snapshot = (): SaveProgress => ({ ...state, refusedReasons: { ...state.refusedReasons }, queued: queuedHands });
  const changed = () => options.onChange?.(snapshot());

  /** Acknowledge every batch owed while there is room. */
  function releaseAcks(): void {
    if (owed > 0 && queuedHands < maxQueued && queuedOriginalBytes < maxOriginalBytes) {
      const count = owed;
      owed = 0;
      options.ack(count);
    }
  }

  function poke(): void {
    const resolve = wake;
    wake = null;
    resolve?.();
    if (!running && state.state !== "paused" && state.state !== "cancelled") {
      void pump();
    }
  }

  function settleIdle(): void {
    if (state.state === "done" || state.state === "paused" || state.state === "cancelled") {
      const waiters = idleWaiters.splice(0);
      for (const resolve of waiters) {
        resolve(snapshot());
      }
    }
  }

  async function persistManifest(): Promise<void> {
    manifest.updatedAt = new Date(now()).toISOString();
    manifest.counts = {
      inserted: state.inserted,
      duplicates: state.duplicates,
      refused: state.refused,
      sourcesDone: state.sourcesDone,
      originalsStored: state.originalsStored,
    };
    try {
      await store?.put(manifest);
    } catch {
      // A manifest that cannot be written costs the resume, never the upload.
    }
  }

  async function record(key: string, batches: number, done: boolean): Promise<void> {
    try {
      await store?.putSource({ upload: manifest.id, key, batches, done });
    } catch {
      // As above.
    }
  }

  const batchesStored = new Map<string, number>();

  async function applyMark(mark: Extract<Item, { kind: "mark" }>): Promise<void> {
    if (mark.batches !== undefined) {
      batchesStored.set(mark.key, mark.batches);
      await record(mark.key, mark.batches, false);
    }
    if (mark.done) {
      if (originalPending.has(mark.key)) {
        endedWaitingOriginal.add(mark.key);
      } else {
        await markDone(mark.key);
      }
    }
  }

  async function markDone(key: string): Promise<void> {
    state.sourcesDone += 1;
    await record(key, batchesStored.get(key) ?? 0, true);
    batchesStored.delete(key);
  }

  /** Runs `call` until it succeeds, or throws the error that ends the attempt. */
  async function withRetry<T>(call: () => Promise<T>): Promise<T | "paused"> {
    let attempts = 0;
    let waits = 0;
    let reregistered = false;
    for (;;) {
      if (state.state === "cancelled") {
        return "paused";
      }
      try {
        const result = await call();
        if (state.state === "retrying" || state.state === "waiting-budget") {
          state.state = "saving";
          state.retryAt = null;
        }
        return result;
      } catch (error) {
        const failure = error instanceof UploadError ? error : new UploadError("transient", String(error));
        state.lastError = failure.message;
        switch (failure.kind) {
          case "transient": {
            attempts += 1;
            if (attempts > retry.attempts) {
              pause("offline");
              return "paused";
            }
            const delay = Math.min(retry.maxMs, retry.baseMs * 2 ** (attempts - 1)) * (0.5 + random() / 2);
            state.state = "retrying";
            state.retryAt = now() + delay;
            changed();
            await sleep(delay);
            break;
          }
          case "rate-limited": {
            waits += 1;
            if (waits > budgetWaits) {
              pause("day-budget");
              return "paused";
            }
            state.state = "waiting-budget";
            state.retryAt = now() + budgetWaitMs;
            changed();
            await sleep(budgetWaitMs);
            break;
          }
          case "rate-limited-day":
            pause("day-budget");
            return "paused";
          case "signed-out":
            pause("signed-out");
            return "paused";
          case "unknown-source":
            if (reregistered) {
              throw failure;
            }
            reregistered = true;
            source = null;
            if (!(await ensureSource())) {
              return "paused";
            }
            break;
          case "refused":
          case "plan":
            throw failure;
        }
      }
    }
  }

  function pause(reason: PauseReason): void {
    state.state = "paused";
    state.pauseReason = reason;
    state.retryAt = null;
    changed();
  }

  async function ensureSource(): Promise<string | null> {
    if (source) {
      return source;
    }
    const id = await withRetry(() => api.registerWebSource()).catch((error: unknown) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      pause("offline");
      return "paused" as const;
    });
    source = id === "paused" ? null : id;
    return source;
  }

  /** Marks at the head of the queue have nothing unsent before them. */
  async function applyLeadingMarks(): Promise<void> {
    while (queue.length > 0 && queue[0].kind === "mark") {
      await applyMark(queue.shift() as Extract<Item, { kind: "mark" }>);
    }
  }

  async function sendRows(): Promise<boolean> {
    const sourceId = await ensureSource();
    if (!sourceId) {
      return false;
    }
    // The call: rows from the head, up to the limits. Marks between them are
    // applied once the call is answered; marks after its last row stay at
    // the head and are applied by the next `applyLeadingMarks`.
    const rows: IngestRow[] = [];
    let bytes = 0;
    let taken = 0;
    const limit = callLimit === null ? maxHands : Math.min(maxHands, callLimit);
    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      if (item.kind === "mark") {
        continue;
      }
      if (rows.length > 0 && (rows.length >= limit || bytes + item.bytes > maxBytes)) {
        break;
      }
      rows.push(item.row);
      bytes += item.bytes;
      taken = i + 1;
    }
    const marks = queue
      .slice(0, taken)
      .filter((item): item is Extract<Item, { kind: "mark" }> => item.kind === "mark");

    let report;
    try {
      const answer = await withRetry(() => api.ingest(source ?? sourceId, rows));
      if (answer === "paused") {
        return false;
      }
      report = answer;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof UploadError && error.kind === "plan") {
        // (R6.4) The plan refused the call whole. Nothing of it was stored
        // and its rows stay queued.
        const refusal = error.refusal;
        if (refusal?.feature === "hand_cap" || refusal?.cap) {
          if (refusal.cap) {
            state.cap = { cap: refusal.cap.cap, stored: refusal.cap.stored };
          }
          // Send what still fits (duplicates cost nothing, so this is at
          // least the room left); always a smaller call than the refused one.
          const fit = Math.min(allowanceOf(refusal), rows.length - 1);
          if (fit > 0) {
            callLimit = fit;
            state.trimmed = true;
            changed();
            return true;
          }
          pause("cap");
          return false;
        }
        pause("plan");
        return false;
      }
      // Refused outright: a bug in what we sent, not in the network. Count
      // the rows as refused, keep going with the rest.
      report = null;
    }
    if (state.state === "cancelled") {
      // `cancel()` emptied the queue while the call was out; what it stored
      // is simply sent again by a resumed upload, as duplicates.
      return false;
    }

    queue.splice(0, taken);
    queuedHands -= rows.length;
    state.sent += rows.length;
    if (report && callLimit !== null) {
      // The room left under the cap; spent, the usual size again (the next
      // refusal, if any, says the library is full).
      callLimit -= report.inserted;
      if (callLimit <= 0) {
        callLimit = null;
      }
    }
    if (report) {
      state.inserted += report.inserted;
      state.duplicates += report.duplicates;
      state.refused += report.rejected;
      for (const row of report.rows) {
        if (row.status === "rejected") {
          const reason = row.reason ?? "invalid";
          state.refusedReasons[reason] = (state.refusedReasons[reason] ?? 0) + 1;
        }
      }
    } else {
      state.refused += rows.length;
      state.refusedReasons.call = (state.refusedReasons.call ?? 0) + rows.length;
    }
    for (const mark of marks) {
      await applyMark(mark);
    }
    await persistManifest();
    releaseAcks();
    changed();
    return true;
  }

  async function sendOriginal(): Promise<boolean> {
    const original = originals[0];
    let outcome: "stored" | "exists" | "paused" | "failed";
    try {
      outcome = await withRetry(() => api.storeOriginal(prefix + original.path, original.blob));
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      outcome = "failed";
    }
    if (outcome === "paused" || state.state === "cancelled") {
      return false;
    }
    originals.shift();
    queuedOriginalBytes -= original.blob.size;
    if (outcome === "failed") {
      state.originalsFailed += 1;
    } else {
      state.originalsStored += 1;
      state.originalsBytes += original.blob.size;
    }
    originalPending.delete(original.key);
    if (endedWaitingOriginal.delete(original.key)) {
      await markDone(original.key);
    }
    await persistManifest();
    releaseAcks();
    changed();
    return true;
  }

  async function sendFailures(): Promise<void> {
    const batch = failures.splice(0, FAILURES_PER_CALL);
    try {
      const recorded = await api.recordFailures(batch);
      state.failuresRecorded = {
        created: (state.failuresRecorded?.created ?? 0) + recorded.created,
        updated: (state.failuresRecorded?.updated ?? 0) + recorded.updated,
      };
    } catch {
      // The corpus is best effort and must never hold up the user's hands.
    }
  }

  async function pump(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      for (;;) {
        if (state.state === "paused" || state.state === "cancelled") {
          break;
        }
        await applyLeadingMarks();
        const hasRows = queue.length > 0;
        let progressed = false;
        if (hasRows) {
          progressed = await sendRows();
          if (!progressed) {
            break;
          }
        }
        if (originals.length > 0) {
          progressed = await sendOriginal();
          if (!progressed) {
            break;
          }
        }
        if (queue.length === 0 && originals.length === 0 && failures.length > 0) {
          await sendFailures();
          progressed = true;
        }
        if (!progressed) {
          if (closed) {
            state.state = "done";
            state.retryAt = null;
            if (originalPending.size === 0) {
              manifest.finished = true;
            }
            await persistManifest();
            if (manifest.finished) {
              try {
                await store?.remove(manifest.id);
              } catch {
                // Left behind: offered once as resumable, harmless.
              }
            }
            changed();
            options.onDone?.(snapshot());
            break;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      running = false;
      settleIdle();
    }
  }

  return {
    addSource(info) {
      if (info.original) {
        originals.push({ key: info.key, path: info.original.path, blob: info.original.blob });
        originalPending.add(info.key);
        queuedOriginalBytes += info.original.blob.size;
        poke();
      }
    },

    addBatch(batch) {
      owed += 1;
      for (const hand of batch.hands) {
        const row = ingestRowOf(hand);
        queue.push({ kind: "row", key: batch.key, row, bytes: JSON.stringify(row).length });
      }
      queuedHands += batch.hands.length;
      state.received += batch.hands.length;
      for (const failure of batch.failures) {
        if (failuresTaken < maxFailures) {
          failures.push(failure);
          failuresTaken += 1;
        }
      }
      queue.push({ kind: "mark", key: batch.key, batches: batch.index + 1 });
      releaseAcks();
      changed();
      poke();
    },

    endSource(key) {
      queue.push({ kind: "mark", key, done: true });
      poke();
    },

    addHands(hands) {
      for (const hand of hands) {
        const row = ingestRowOf(hand);
        queue.push({ kind: "row", key: "", row, bytes: JSON.stringify(row).length });
      }
      queuedHands += hands.length;
      state.received += hands.length;
      changed();
      poke();
    },

    close() {
      closed = true;
      poke();
    },

    resume() {
      if (state.state !== "paused") {
        return;
      }
      state.state = "saving";
      state.pauseReason = null;
      // (R6.4) After an upgrade the cap is gone: full calls again.
      state.cap = null;
      callLimit = null;
      changed();
      poke();
    },

    cancel() {
      state.state = "cancelled";
      queue.length = 0;
      originals.length = 0;
      queuedHands = 0;
      queuedOriginalBytes = 0;
      const resolve = wake;
      wake = null;
      resolve?.();
      changed();
      settleIdle();
    },

    progress: snapshot,

    idle() {
      if (!running && (state.state === "done" || state.state === "paused" || state.state === "cancelled")) {
        return Promise.resolve(snapshot());
      }
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
