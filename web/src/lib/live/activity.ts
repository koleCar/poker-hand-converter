/**
 * Live progress across an account's tabs and devices (Rail R4.3).
 *
 * The tab running a bulk upload (R4.2) publishes a small summary of it -
 * state and counts, never a hand or a file name - as its **presence** on the
 * account's private Realtime channel `activity:<uid>`
 * (`components/live/activityChannel.ts`; authorised by
 * `20270616090000_live_activity.sql`). Every other tab of the account reads
 * the channel's presence state and shows "Saving 120 000 of ~1 000 000 hands
 * from a web upload", then "finished".
 *
 * This module is the part that needs no socket, so it is tested under plain
 * Node (`tests/test/liveActivity.test.ts`):
 *
 * - **What is published** (`UploadActivity`, `uploadActivityOf`,
 *   `estimateUploadTotal`) and how a received entry is read back
 *   (`uploadActivityFromMeta`: defensive, the payload crossed a network).
 * - **How often** (`createActivityPublisher`): at most once per
 *   `minIntervalMs` (2 s) while counts move, a state change at once, a
 *   heartbeat every `heartbeatMs` (15 s) while nothing moves, and after the
 *   upload finishes its final state stays up for `lingerMs` (20 s) so other
 *   tabs see the end, then it is withdrawn. Presence is in Realtime's memory:
 *   none of this writes to the database.
 * - **What a viewer shows** (`createActivityBoard`): the latest entry per
 *   tab, minus the viewer's own; an entry that has not changed for
 *   `staleMs` (45 s, three missed heartbeats) is gone - a frozen tab cannot
 *   leave a bar standing - and an entry whose tab left the channel is gone at
 *   once, unless it had finished, which stays for `finishedMs` (20 s).
 *   Times are the viewer's own clock: the uploader's `at` only marks a
 *   change, so a skewed clock elsewhere cannot keep an entry alive.
 */

export type UploadActivityState =
  /** Sending, or waiting for the converter. */
  | "saving"
  /** A transient failure; trying again shortly. */
  | "retrying"
  /** The account's ingest budget is spent; waiting to send again. */
  | "waiting"
  /** Stopped with work left; the uploading tab offers "Try again". */
  | "paused"
  /** Everything handed over is stored (or refused). */
  | "done";

const STATES: readonly UploadActivityState[] = ["saving", "retrying", "waiting", "paused", "done"];

/** One tab's upload, as published on the channel. ~200 bytes of JSON. */
export interface UploadActivity {
  v: 1;
  kind: "upload";
  /** The upload's random id (its manifest's), not anything about the files. */
  id: string;
  state: UploadActivityState;
  /** Hands the server has answered for (stored + already there + refused). */
  sent: number;
  /** Of those, newly stored. */
  inserted: number;
  /** Of those, already in the library. */
  duplicates: number;
  /** Hands converted and handed to the saver so far. */
  received: number;
  /** Hands the upload will save in all: exact once converting ended, an estimate before, null when unknown. */
  total: number | null;
  /** True while `total` is an estimate. */
  estimated: boolean;
  /** The uploader's clock when this was published; marks a change only. */
  at: number;
}

export function isFinished(activity: UploadActivity): boolean {
  return activity.state === "done";
}

/** A count off the wire: a non-negative whole number, or 0. */
function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Reads one presence entry. Anything that is not an upload of this version
 * is ignored (null) rather than guessed at: a newer build's entries are
 * skipped, never misread.
 */
export function uploadActivityFromMeta(meta: unknown): UploadActivity | null {
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const record = meta as Record<string, unknown>;
  if (record.v !== 1 || record.kind !== "upload" || typeof record.id !== "string" || record.id.length === 0 || record.id.length > 64) {
    return null;
  }
  const state = STATES.find((candidate) => candidate === record.state);
  if (!state) {
    return null;
  }
  const total = record.total === null || record.total === undefined ? null : count(record.total) || null;
  return {
    v: 1,
    kind: "upload",
    id: record.id,
    state,
    sent: count(record.sent),
    inserted: count(record.inserted),
    duplicates: count(record.duplicates),
    received: count(record.received),
    total,
    estimated: total !== null && record.estimated === true,
    at: count(record.at),
  };
}

/** Bytes known before an estimate is offered: early guesses swing wildly. */
const ESTIMATE_MIN_FRACTION = 0.02;

/** What the converting tab knows about the drop so far. */
export interface UploadExtent {
  /**
   * Hands the files opened so far hold: a file's split is known as soon as
   * it is opened (its hands minus those refused), long before the save gets
   * there.
   */
  knownHands: number;
  /** Bytes of the files opened so far. */
  bytesKnown: number;
  /** Bytes of the whole drop that can hold hands. */
  bytesTotal: number;
  converting: boolean;
}

/**
 * How many hands the upload will have in all.
 *
 * While converting: the hands of the files opened so far, scaled up by the
 * bytes not opened yet (hand histories are roughly uniform in bytes per
 * hand), once at least 2 % of the drop is known; never less than what was
 * already handed to the saver. A single big file is exact as soon as it is
 * split. After converting: exactly what was converted.
 */
export function estimateUploadTotal(
  received: number,
  extent: UploadExtent,
): { total: number | null; estimated: boolean } {
  const handed = count(received);
  if (!extent.converting) {
    return { total: handed, estimated: false };
  }
  const known = count(extent.knownHands);
  const bytesKnown = count(extent.bytesKnown);
  const all = count(extent.bytesTotal);
  if (known === 0 || all === 0 || bytesKnown < all * ESTIMATE_MIN_FRACTION) {
    return { total: null, estimated: false };
  }
  const scaled = bytesKnown >= all ? known : Math.round((known * all) / bytesKnown);
  return { total: Math.max(handed, scaled), estimated: true };
}

/** The saver's progress, as much of it as is published (`bulkSaver.ts`'s `SaveProgress`). */
export interface SaverProgressLike {
  state: "saving" | "retrying" | "waiting-budget" | "paused" | "done" | "cancelled";
  received: number;
  sent: number;
  inserted: number;
  duplicates: number;
}

/**
 * What to publish for the upload a tab is running; null when there is
 * nothing to show. `at` is left 0: the publisher stamps it when it sends.
 */
export function uploadActivityOf(
  id: string,
  progress: SaverProgressLike,
  extent: UploadExtent,
): UploadActivity | null {
  if (progress.state === "cancelled") {
    return null;
  }
  const state: UploadActivityState = progress.state === "waiting-budget" ? "waiting" : progress.state;
  const { total, estimated } = estimateUploadTotal(progress.received, extent);
  return {
    v: 1,
    kind: "upload",
    id,
    state,
    sent: count(progress.sent),
    inserted: count(progress.inserted),
    duplicates: count(progress.duplicates),
    received: count(progress.received),
    total,
    estimated,
    at: 0,
  };
}

/* ------------------------------------------------------------ publisher - */

export interface ActivityTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: ActivityTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export const ACTIVITY_MIN_INTERVAL_MS = 2_000;
export const ACTIVITY_HEARTBEAT_MS = 15_000;
export const ACTIVITY_LINGER_MS = 20_000;
export const ACTIVITY_STALE_MS = 45_000;
export const ACTIVITY_FINISHED_MS = 20_000;

export interface ActivityPublisherOptions {
  /** Publishes (a presence track) or, with null, withdraws (an untrack). */
  send(activity: UploadActivity | null): void;
  minIntervalMs?: number;
  heartbeatMs?: number;
  lingerMs?: number;
  timers?: ActivityTimers;
}

export interface ActivityPublisher {
  /** The upload's current state; sent now, or within `minIntervalMs`. */
  update(activity: UploadActivity): void;
  /** Withdraws now (an upload reset, the page leaving); nothing is sent again. */
  dispose(): void;
}

/** Fields whose change is worth sending at once rather than at the next tick. */
function stateKey(activity: UploadActivity): string {
  return `${activity.id}|${activity.state}`;
}

function sameCounts(a: UploadActivity, b: UploadActivity): boolean {
  return (
    a.sent === b.sent &&
    a.inserted === b.inserted &&
    a.duplicates === b.duplicates &&
    a.received === b.received &&
    a.total === b.total &&
    a.estimated === b.estimated
  );
}

export function createActivityPublisher(options: ActivityPublisherOptions): ActivityPublisher {
  const minInterval = options.minIntervalMs ?? ACTIVITY_MIN_INTERVAL_MS;
  const heartbeat = options.heartbeatMs ?? ACTIVITY_HEARTBEAT_MS;
  const linger = options.lingerMs ?? ACTIVITY_LINGER_MS;
  const timers = options.timers ?? realTimers;

  let disposed = false;
  let latest: UploadActivity | null = null;
  let sent: UploadActivity | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let withdrawn = true;
  let timer: unknown = null;

  function cancel() {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
  }

  function arm(callback: () => void, ms: number) {
    cancel();
    timer = timers.set(() => {
      timer = null;
      callback();
    }, Math.max(0, ms));
  }

  function sendNow() {
    if (disposed || !latest) {
      return;
    }
    const now = timers.now();
    sent = { ...latest, at: now };
    sentAt = now;
    withdrawn = false;
    options.send(sent);
    if (isFinished(sent)) {
      // The end stays up long enough to be seen, then goes.
      arm(() => {
        if (!disposed) {
          withdrawn = true;
          options.send(null);
        }
      }, linger);
    } else {
      // Nothing moved for a while: say so, so viewers know the tab is alive.
      arm(sendNow, heartbeat);
    }
  }

  return {
    update(activity) {
      if (disposed) {
        return;
      }
      latest = activity;
      if (!sent || withdrawn || stateKey(sent) !== stateKey(activity)) {
        // A new upload, or a new state: at once.
        sendNow();
        return;
      }
      if (isFinished(sent) || sameCounts(sent, activity)) {
        return; // the linger or heartbeat timer already runs
      }
      const due = sentAt + minInterval - timers.now();
      if (due <= 0) {
        sendNow();
      } else {
        arm(sendNow, due);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      cancel();
      if (!withdrawn) {
        withdrawn = true;
        options.send(null);
      }
    },
  };
}

/* ---------------------------------------------------------------- board - */

/** Realtime's presence state: per presence key (one per tab), the metas tracked under it. */
export type PresenceState = Record<string, unknown[]>;

export interface ActivityBoardOptions {
  staleMs?: number;
  finishedMs?: number;
  now?: () => number;
}

export interface ActivityBoard {
  /** A presence sync: the channel's whole state. `ownKey` (this tab) is left out. */
  sync(state: PresenceState, ownKey?: string | null): void;
  /** What to show now, oldest upload first. */
  visible(): UploadActivity[];
  /** Epoch ms when `visible()` next changes on its own (an entry expiring); null if never. */
  nextChange(): number | null;
  clear(): void;
}

interface Entry {
  activity: UploadActivity;
  /** The viewer's clock when this entry last changed. */
  changedAt: number;
  /** Still in the channel's presence state. */
  present: boolean;
}

export function createActivityBoard(options: ActivityBoardOptions = {}): ActivityBoard {
  const staleMs = options.staleMs ?? ACTIVITY_STALE_MS;
  const finishedMs = options.finishedMs ?? ACTIVITY_FINISHED_MS;
  const now = options.now ?? (() => Date.now());
  /** Keyed by upload id: one upload is one line, whichever tab tracks it. */
  const entries = new Map<string, Entry>();

  function expiresAt(entry: Entry): number {
    if (isFinished(entry.activity)) {
      return entry.changedAt + finishedMs;
    }
    return entry.present ? entry.changedAt + staleMs : entry.changedAt;
  }

  function prune(at: number) {
    for (const [id, entry] of entries) {
      if (expiresAt(entry) <= at) {
        entries.delete(id);
      }
    }
  }

  return {
    sync(state, ownKey = null) {
      const at = now();
      const seen = new Map<string, UploadActivity>();
      for (const [key, metas] of Object.entries(state ?? {})) {
        if (key === ownKey || !Array.isArray(metas)) {
          continue;
        }
        for (const meta of metas) {
          const activity = uploadActivityFromMeta(meta);
          if (!activity) continue;
          const other = seen.get(activity.id);
          if (!other || activity.at >= other.at) {
            seen.set(activity.id, activity);
          }
        }
      }
      for (const [id, activity] of seen) {
        const entry = entries.get(id);
        const changed = !entry || entry.activity.at !== activity.at || entry.activity.state !== activity.state || !sameCounts(entry.activity, activity);
        entries.set(id, { activity, changedAt: changed || !entry ? at : entry.changedAt, present: true });
      }
      for (const [id, entry] of entries) {
        if (!seen.has(id) && entry.present) {
          // Its tab left (closed, offline, withdrew). A finished upload keeps
          // its last line for a while; anything else goes now.
          entries.set(id, { ...entry, present: false, changedAt: isFinished(entry.activity) ? entry.changedAt : at });
        }
      }
      prune(at);
    },
    visible() {
      prune(now());
      return Array.from(entries.values())
        .map((entry) => entry.activity)
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    nextChange() {
      let next: number | null = null;
      for (const entry of entries.values()) {
        const at = expiresAt(entry);
        if (next === null || at < next) next = at;
      }
      return next;
    },
    clear() {
      entries.clear();
    },
  };
}
