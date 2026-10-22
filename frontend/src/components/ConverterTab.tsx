/**
 * Batch conversion — the "Many hands" mode of the upload tab.
 *
 * The single-hand path is `upload/SingleHandPanel`; `upload/UploadTab` picks
 * between them. This file is everything that only matters in bulk: a worker, a
 * progress bar, coalesced state flushes, the save and a failure corpus.
 *
 * What it does, in order: take files (dropped, picked, pasted, zipped or in a
 * dropped folder), decode them properly, detect which poker room wrote them,
 * convert every hand off the main thread, save the good ones to the library and
 * the unconvertible ones to the failure corpus, and then let the user download
 * the result or open any single hand in the replayer.
 *
 * Decisions worth knowing about:
 *
 *  * **Conversion starts as soon as files arrive.** There is no "convert" step.
 *    The intent of dropping a hand history on a hand history converter is not
 *    ambiguous, and the cancel button covers the accident.
 *  * **The work runs in a worker** - since R4.2 the reading too: the worker
 *    gets the dropped `File` handles and reads, unzips and decodes one file at
 *    a time (`converter/bulkSource.ts`), so a 400 MB export never sits in the
 *    tab whole. See `workers/convert.worker.ts`.
 *  * **Saving runs alongside** (R4.2, `converter/bulkSaver.ts`): a signed-in
 *    user's hands are saved as they are converted, in chunks, retried, and
 *    the worker is held back while the save is behind - so the tab holds a
 *    bounded number of hands however big the drop. An interrupted upload
 *    resumes when the same files are dropped again (`uploadManifest.ts`).
 *  * **The tab keeps the first {@link RETAIN_HANDS} hands** for the list,
 *    previews and downloads; past that it keeps counting, not holding.
 *  * **Failures are a feature.** A hand we cannot read is stored on purpose as
 *    reference material for the next parser, and the user is told exactly that.
 *  * **A guest converts first and signs in afterwards.** Conversion never waits
 *    for an account. When a run finishes with nobody signed in, the results are
 *    held in memory and offered — "sign in to save these 412 hands" — so the
 *    work is never lost and the login never arrives before the value does.
 *  * **Originals stay in the tab** unless the user ticks "keep the original
 *    files" (A2): then each file is stored, compressed, in their private
 *    folder of the `hand-uploads` bucket. Off by default, every visit.
 *
 * The page stays fully usable with no database and with no account: conversion,
 * preview, download and the replayer hand-off never touch Supabase.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/auth";
import { isDatabaseConfigured, rebuildStats, recordConversionFailures } from "../lib/db";
import { currentUserId, requireDb } from "../lib/db/client";
import { createUploadApi, type UploadClient } from "../lib/db/upload";
import { useDict, useLocale } from "../lib/i18n/client";
import { INTL_LOCALE } from "../lib/i18n/dictionaries";
import { getParser, getParsers } from "../lib/phf";
import { paths } from "../lib/routes";
import type { ConversionFailure } from "../lib/phf/detect";
import type { PhfHand } from "../lib/phf/types";
import type { InputItem } from "./converter/bulkSource";
import type { SourceInfo } from "./converter/bulkRun";
import { createBulkSaver, type BulkSaver, type SaveProgress } from "./converter/bulkSaver";
import { uploadActivityOf } from "../lib/live/activity";
import { useUploadPresence } from "./live/useLiveActivity";
import { DropZone } from "./converter/DropZone";
import { FailurePanel } from "./converter/FailurePanel";
import { HandPreview } from "./converter/HandPreview";
import { ResultsPanel } from "./converter/ResultsPanel";
import { startBulkConversion, type BulkJob } from "./converter/conversionClient";
import { parkHandForReplayer } from "./converter/handoff";
import { formatBytes, type PickedFile } from "./converter/inputs";
import type { StreamBatch } from "./converter/pipeline";
import { IDLE_SAVE, type SaveState, type SourceResult } from "./converter/types";
import {
  indexedDbManifestStore,
  isSameUpload,
  newManifest,
  resumeStateOf,
  type ManifestStore,
  type UploadManifest,
} from "./converter/uploadManifest";
import "../styles/converter.css";

const AUTO_SAVE_KEY = "pokerconverter.autoSave";

/**
 * How often streamed batches are folded into React state, in ms.
 *
 * Five updates a second: fast enough that the counters look continuous, slow
 * enough that rendering the results list does not eat the frame budget the
 * worker just freed up. Measured on the 7.9 MB corpus at 1440px, the 95th
 * percentile frame gap goes 32 ms (flush per batch) → 30 ms (120 ms) → 23 ms
 * (200 ms), against 18 ms with the results list hidden entirely.
 */
const FLUSH_MS = 200;

/**
 * Converted hands the tab keeps for the list, previews and downloads (R4.2).
 * ~20 000 PHF objects is ~150 MB of heap in Chrome; past it a drop is counted
 * and saved, not held. Refused hands carry their raw text, so fewer of them.
 */
const RETAIN_HANDS = 20_000;
const RETAIN_FAILURES = 2_000;

/** Batches the worker may convert ahead of the save. */
const WORKER_WINDOW = 4;

interface ConverterTabProps {
  /** Lets the shell refresh its stored-hand counter. Optional; defaults to a no-op. */
  onHandsSaved?: () => void;
  /**
   * Overrides how a hand is opened in the replayer.
   *
   * The default parks the hand in `sessionStorage` and navigates to
   * `/library` (see `converter/handoff.ts`). Pass this once the shell can hand
   * a loaded hand to the replayer directly.
   */
  onOpenHand?: (hand: PhfHand, standardText: string) => void;
}

function readAutoSavePreference(): boolean {
  if (!isDatabaseConfigured) {
    return false;
  }
  try {
    return localStorage.getItem(AUTO_SAVE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** A read input becomes a result row straight away, before it is converted. */
function toResult(source: SourceInfo): SourceResult {
  return {
    id: source.id,
    name: source.name,
    bytes: source.bytes,
    encoding: source.encoding,
    problem: source.problem,
    status: source.problem ? "skipped" : "queued",
    siteId: null,
    siteName: null,
    confidence: null,
    total: 0,
    done: 0,
    handCount: 0,
    failureCount: 0,
    hands: [],
    failures: [],
    truncated: false,
  };
}

/** A finished run that had nowhere to go because nobody was signed in. */
type HeldSave =
  | { kind: "hands"; hands: PhfHand[]; failures: ConversionFailure[] }
  /** Too many to hold: the user has to drop the files again after signing in. */
  | { kind: "too-many"; count: number };

/** Bytes of the drop read so far, and what was left out. */
interface ReadProgress {
  bytes: number;
  total: number;
  /** Files an earlier attempt already stored. */
  done: number;
  /** Files that are not hand histories. */
  other: number;
}

const NO_READ: ReadProgress = { bytes: 0, total: 0, done: 0, other: 0 };

/** The bulk save's progress in the results panel's older shape. */
function toSaveState(progress: SaveProgress | null, pausedMessage: string | null): SaveState {
  if (!progress || progress.state === "cancelled") {
    return IDLE_SAVE;
  }
  const refusedCall = (progress.refusedReasons.call ?? 0) > 0;
  const status: SaveState["status"] =
    progress.state === "paused" || (progress.state === "done" && refusedCall)
      ? "error"
      : progress.state === "done"
        ? "done"
        : "saving";
  return {
    status,
    inserted: progress.inserted,
    duplicates: progress.duplicates,
    total: progress.received,
    done: progress.sent,
    errors: progress.state === "paused" && pausedMessage
      ? [pausedMessage]
      : refusedCall && progress.lastError
        ? [progress.lastError]
        : [],
  };
}

export function ConverterTab({ onHandsSaved, onOpenHand }: ConverterTabProps) {
  const t = useDict().converter.batch;
  const locale = INTL_LOCALE[useLocale()];
  const router = useRouter();

  // Results live in a map mutated as messages arrive and are published to
  // React at most every FLUSH_MS (`publish`): a drop of 30 000 files would
  // otherwise re-map a 30 000-row array on every message.
  const resultsRef = useRef(new Map<string, SourceResult>());
  const [sources, setSources] = useState<SourceResult[]>([]);

  const [reading, setReading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [read, setRead] = useState<ReadProgress>(NO_READ);
  const [upload, setUpload] = useState<SaveProgress | null>(null);
  /** The running upload's id (its manifest's), published to the account's other tabs (R4.3). */
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [legacySave, setLegacySave] = useState<SaveState>(IDLE_SAVE);
  const [recorded, setRecorded] = useState<{ created: number; updated: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(readAutoSavePreference);
  const [keepOriginals, setKeepOriginals] = useState(false);
  const [preview, setPreview] = useState<PhfHand | null>(null);
  const [usedWorker, setUsedWorker] = useState<boolean | null>(null);
  const [held, setHeld] = useState<HeldSave | null>(null);
  const [resumable, setResumable] = useState<UploadManifest | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const auth = useAuth();
  const jobRef = useRef<BulkJob | null>(null);
  const saverRef = useRef<BulkSaver | null>(null);
  /** The running (or last) upload's manifest: a paused one resumes on a re-drop. */
  const manifestRef = useRef<UploadManifest | null>(null);
  const storeRef = useRef<ManifestStore | null | undefined>(undefined);
  const retainedRef = useRef({ hands: 0, failures: 0 });
  // Read inside the pipeline callbacks, which are created once per job and
  // would otherwise close over a stale toggle.
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const keepOriginalsRef = useRef(keepOriginals);
  keepOriginalsRef.current = keepOriginals;
  const signedInRef = useRef(auth.isSignedIn);
  signedInRef.current = auth.isSignedIn;

  const store = useCallback((): ManifestStore | null => {
    if (storeRef.current === undefined) {
      storeRef.current = indexedDbManifestStore();
    }
    return storeRef.current;
  }, []);

  // Straight from the registry, so a parser added tomorrow shows up here with
  // no change to this file. Our own re-import format sorts last because it is
  // not a poker room and the hint text only has space for a handful of names.
  const siteNames = useMemo(
    () =>
      getParsers()
        .map((parser) => ({ id: parser.id, name: parser.name }))
        .sort((a, b) => Number(a.id === "standard") - Number(b.id === "standard"))
        .map((parser) => parser.name),
    [],
  );

  const siteLabel = useCallback(
    (siteId: string | null) =>
      siteId ? getParser(siteId)?.name ?? siteId : t.unknownFormat,
    [t],
  );

  const openInReplayer = useCallback(
    (hand: PhfHand, standardText?: string) => {
      if (onOpenHand) {
        onOpenHand(hand, standardText ?? "");
        return;
      }
      // Park first, then navigate: `LibraryHands` consumes the key on mount, so
      // the hand has to be there before the route changes.
      parkHandForReplayer(hand, standardText);
      router.push(paths.library());
    },
    [onOpenHand, router],
  );

  /* ---------------------------------------------------- the results map - */

  const flushTimerRef = useRef<number | null>(null);
  // The save's progress arrives per call; it is published with the results.
  const uploadRef = useRef<SaveProgress | null>(null);
  const publish = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setSources(Array.from(resultsRef.current.values()));
    setUpload(uploadRef.current);
  }, []);
  const schedulePublish = useCallback(() => {
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(publish, FLUSH_MS);
    }
  }, [publish]);

  const update = useCallback(
    (id: string, change: (source: SourceResult) => SourceResult) => {
      const current = resultsRef.current.get(id);
      if (current) {
        resultsRef.current.set(id, change(current));
        schedulePublish();
      }
    },
    [schedulePublish],
  );

  const onSaveChange = useCallback(
    (progress: SaveProgress) => {
      uploadRef.current = progress;
      if (progress.state === "saving") {
        schedulePublish();
      } else {
        // A state change (retrying, waiting, paused, done) shows at once.
        setUpload(progress);
      }
    },
    [schedulePublish],
  );

  /* ------------------------------------------------------- resumable run - */

  // An upload that stopped before it finished, offered once the session is
  // known. Only the newest per account; a new drop replaces it.
  useEffect(() => {
    if (!isDatabaseConfigured || !auth.isSignedIn) {
      setResumable(null);
      return;
    }
    let live = true;
    void (async () => {
      const userId = await currentUserId();
      const manifests = store();
      if (!userId || !manifests) {
        return;
      }
      try {
        const latest = await manifests.latest(userId);
        if (live && !saverRef.current) {
          setResumable(latest);
        }
      } catch {
        // No resume offer; nothing else depends on it.
      }
    })();
    return () => {
      live = false;
    };
  }, [auth.isSignedIn, store]);

  const forgetResumable = useCallback(() => {
    const manifest = resumable;
    setResumable(null);
    if (manifest) {
      void store()?.remove(manifest.id).catch(() => undefined);
    }
  }, [resumable, store]);

  /* ------------------------------------------------------------- saving - */

  /** After the save finishes: statistics, and the shell's counter. */
  const afterSave = useCallback(
    (progress: SaveProgress) => {
      onHandsSaved?.();
      // Statistics are derived server-side from what was just stored, and in
      // the background: a statistics failure must never read as "your upload
      // failed". The statistics screen picks up anything this misses.
      if (progress.inserted > 0) {
        void rebuildStats().catch(() => undefined);
      }
    },
    [onHandsSaved],
  );

  /** A saver for this tab's session; `manifest` null for held hands (no resume). */
  const makeSaver = useCallback(
    (userId: string, manifest: UploadManifest, manifests: ManifestStore | null): BulkSaver => {
      const saver = createBulkSaver({
        api: createUploadApi(requireDb() as unknown as UploadClient),
        store: manifests,
        manifest,
        userId,
        ack: (batches) => jobRef.current?.ack(batches),
        onChange: onSaveChange,
        onDone: afterSave,
      });
      saverRef.current = saver;
      manifestRef.current = manifest;
      setUploadId(manifest.id);
      return saver;
    },
    [afterSave, onSaveChange],
  );

  /** Saves hands the tab holds (a guest's run, after sign-in). */
  const persistHeld = useCallback(
    async (hands: PhfHand[], failures: ConversionFailure[]) => {
      const userId = await currentUserId();
      if (!userId) {
        return;
      }
      if (failures.length > 0) {
        setRecorded(null);
        // Deliberately not awaited before the hands: the corpus is the lower
        // priority write and must never delay the user's own library.
        void recordConversionFailures(failures)
          .then((result) => setRecorded({ created: result.created, updated: result.updated }))
          .catch(() => setRecorded({ created: 0, updated: 0 }));
      }
      if (hands.length === 0) {
        return;
      }
      setLegacySave(IDLE_SAVE);
      const saver = makeSaver(userId, newManifest(userId, [], false), null);
      saver.addHands(hands);
      saver.close();
    },
    [makeSaver],
  );

  /**
   * Flush a held run the moment a session appears.
   *
   * Covers signing in from the button below *and* from anywhere else — the
   * header menu, another tab, an OAuth redirect that landed back on this page.
   * All of them surface here as `isSignedIn` flipping to true, so there is one
   * path to get right instead of four.
   */
  useEffect(() => {
    if (!auth.isSignedIn || !held || held.kind !== "hands" || !autoSaveRef.current) {
      return;
    }
    const pending = held;
    setHeld(null);
    void persistHeld(pending.hands, pending.failures);
  }, [auth.isSignedIn, held, persistHeld]);

  /* --------------------------------------------------------- conversion - */

  /**
   * Stop the worker, the save and the flush timer when the tab goes away.
   *
   * The app has a real router, so navigating to the replayer mid-conversion
   * is something a user can actually do — and a worker nobody is listening to
   * keeps burning a core while its `postMessage` handlers set state on an
   * unmounted component. A save cut off here resumes from its manifest.
   */
  useEffect(
    () => () => {
      jobRef.current?.cancel();
      jobRef.current = null;
      saverRef.current?.cancel();
      saverRef.current = null;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    },
    [],
  );

  const saving = upload !== null && (upload.state === "saving" || upload.state === "retrying" || upload.state === "waiting-budget");

  // Closing the tab mid-save loses nothing that is stored, but the rest has to
  // be dropped again: say so before it happens.
  useEffect(() => {
    if (!saving && !converting) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      if (saverRef.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saving, converting]);

  // The retry countdown ticks once a second while there is one.
  useEffect(() => {
    if (!upload?.retryAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [upload?.retryAt]);

  const convert = useCallback(
    async (items: InputItem[]) => {
      if (items.length === 0) {
        return;
      }
      setConverting(true);
      setError(null);
      setLegacySave(IDLE_SAVE);
      setRecorded(null);
      setHeld(null);
      // An upload of this session that stopped short (paused, or stopped by
      // the user) is as resumable as one from an earlier visit.
      const unfinished =
        resumable ??
        (uploadRef.current && uploadRef.current.state !== "done" && !manifestRef.current?.finished
          ? manifestRef.current
          : null);
      setUpload(null);
      uploadRef.current = null;
      saverRef.current?.cancel();
      saverRef.current = null;

      const inputs = items.map((item) =>
        item.kind === "file" ? { path: item.path, size: item.file.size } : { path: item.name, size: item.text.length },
      );
      setRead({ ...NO_READ, total: inputs.reduce((sum, input) => sum + input.size, 0) });

      // Save as we go when the user can: database, switch on, signed in.
      let saver: BulkSaver | null = null;
      let resume = { done: [] as string[], batches: [] as Array<[string, number]> };
      const keep = keepOriginalsRef.current;
      const userId = isDatabaseConfigured && autoSaveRef.current && signedInRef.current ? await currentUserId() : null;
      if (userId) {
        const manifests = store();
        let manifest: UploadManifest;
        if (unfinished && unfinished.userId === userId && isSameUpload(unfinished, inputs)) {
          manifest = { ...unfinished, keepOriginals: keep };
          try {
            resume = resumeStateOf((await manifests?.sources(manifest.id)) ?? []);
          } catch {
            // Without the record the drop is sent again; the server dedupes.
          }
        } else {
          if (unfinished) {
            void manifests?.remove(unfinished.id).catch(() => undefined);
          }
          manifest = newManifest(userId, inputs, keep);
          try {
            await manifests?.put(manifest);
          } catch {
            // As above.
          }
        }
        setResumable(null);
        saver = makeSaver(userId, manifest, manifests);
      }

      const retainedHands: PhfHand[] = [];
      const retainedFailures: ConversionFailure[] = [];
      retainedRef.current = { hands: 0, failures: 0 };
      let converted = 0;
      let truncated = false;
      const guestHolding = isDatabaseConfigured && autoSaveRef.current && !signedInRef.current;

      jobRef.current = startBulkConversion(
        {
          items,
          // Everything converts: the old tab was cash-only, but a user with a
          // tournament history wants it converted, not silently dropped.
          options: { validate: true },
          keepOriginals: saver !== null && keep,
          resume,
          window: WORKER_WINDOW,
        },
        {
          onSource: (info) => {
            resultsRef.current.set(info.id, toResult(info));
            saver?.addSource(info);
            schedulePublish();
          },
          onConsumed: (consumed) => {
            setRead((current) => ({
              ...current,
              bytes: current.bytes + consumed.bytes,
              done: current.done + consumed.done,
              other: current.other + consumed.other,
            }));
          },
          onSourceStart: (start) =>
            update(start.sourceId, (source) => ({
              ...source,
              status: "running",
              siteId: start.siteId,
              siteName: start.siteName,
              confidence: start.confidence,
              total: start.total,
            })),
          onBatch: (batch: StreamBatch) => {
            converted += batch.hands.length;
            const room = RETAIN_HANDS - retainedRef.current.hands;
            const keptHands = room > 0 ? batch.hands.slice(0, room) : [];
            const failureRoom = RETAIN_FAILURES - retainedRef.current.failures;
            const keptFailures = failureRoom > 0 ? batch.failures.slice(0, failureRoom) : [];
            retainedRef.current.hands += keptHands.length;
            retainedRef.current.failures += keptFailures.length;
            const cut = keptHands.length < batch.hands.length;
            truncated ||= cut;
            if (guestHolding && !truncated) {
              retainedHands.push(...keptHands);
            }
            retainedFailures.push(...keptFailures);
            update(batch.sourceId, (source) => ({
              ...source,
              done: batch.done,
              total: batch.total,
              handCount: source.handCount + batch.hands.length,
              failureCount: source.failureCount + batch.failures.length,
              hands: keptHands.length ? source.hands.concat(keptHands) : source.hands,
              failures: keptFailures.length ? source.failures.concat(keptFailures) : source.failures,
              truncated: source.truncated || cut,
            }));
            if (saver) {
              saver.addBatch(batch);
            } else {
              jobRef.current?.ack(1);
            }
          },
          onSourceEnd: (sourceId, key) => {
            saver?.endSource(key);
            update(sourceId, (source) => ({ ...source, status: "done" }));
          },
          onDone: ({ cancelled, usedWorker: worker }) => {
            jobRef.current = null;
            for (const [id, source] of resultsRef.current) {
              if (source.status === "running" || source.status === "queued") {
                resultsRef.current.set(id, { ...source, status: cancelled ? "cancelled" : "done" });
              }
            }
            publish();
            setUsedWorker(worker);
            setConverting(false);
            // A cancelled run still saves what it converted; throwing away work
            // the user already waited for would be the wrong kind of tidy.
            saver?.close();
            if (!saver && guestHolding && converted > 0) {
              setHeld(truncated ? { kind: "too-many", count: converted } : { kind: "hands", hands: retainedHands, failures: retainedFailures });
            }
          },
          onError: (message) => {
            jobRef.current = null;
            for (const [id, source] of resultsRef.current) {
              if (source.status === "running") {
                resultsRef.current.set(id, { ...source, status: "done" });
              }
            }
            publish();
            setConverting(false);
            setError(message || t.workerStopped);
            saver?.close();
          },
        },
      );
    },
    [makeSaver, publish, resumable, schedulePublish, store, t, update],
  );

  /* -------------------------------------------------------------- input - */

  const handleFiles = useCallback(
    (files: PickedFile[]) => {
      void convert(files.map((picked) => ({ kind: "file", file: picked.file, path: picked.path })));
    },
    [convert],
  );

  const handleText = useCallback(
    (text: string) => {
      const existing = sources.filter((source) => source.name.startsWith(t.pastedText)).length;
      void convert([{ kind: "text", name: existing ? t.pastedTextNumbered(existing + 1) : t.pastedText, text }]);
    },
    [convert, sources, t],
  );

  function reset() {
    jobRef.current?.cancel();
    jobRef.current = null;
    saverRef.current?.cancel();
    saverRef.current = null;
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    resultsRef.current = new Map();
    retainedRef.current = { hands: 0, failures: 0 };
    uploadRef.current = null;
    setSources(Array.from(resultsRef.current.values()));
    setUpload(null);
    setLegacySave(IDLE_SAVE);
    setRead(NO_READ);
    setRecorded(null);
    setError(null);
    setConverting(false);
    setReading(false);
    setPreview(null);
    setHeld(null);
  }

  /* ----------------------------------------------------------- progress - */

  const progress = useMemo(() => {
    const runnable = sources.filter((source) => !source.problem);
    const finished = runnable.filter((source) => source.status === "done" || source.status === "cancelled");
    const running = runnable.find((source) => source.status === "running");
    const handsDone = sources.reduce((sum, source) => sum + source.handCount, 0);
    const percent = read.total > 0 ? Math.min(100, Math.round((read.bytes / read.total) * 100)) : 0;
    // For the estimate other tabs show (R4.3): a file's hands are known once
    // it is split, long before they are all saved.
    let knownHands = 0;
    let bytesKnown = 0;
    let bytesUnusable = 0;
    for (const source of sources) {
      if (source.problem) {
        bytesUnusable += source.bytes;
      } else if (source.status === "done" || source.status === "cancelled") {
        knownHands += source.handCount;
        bytesKnown += source.bytes;
      } else if (source.total > 0) {
        knownHands += Math.max(source.handCount, source.total - source.failureCount);
        bytesKnown += source.bytes;
      }
    }
    return {
      files: runnable.length,
      filesDone: finished.length,
      current: running ?? null,
      handsDone,
      percent,
      extent: { knownHands, bytesKnown, bytesTotal: Math.max(0, read.total - bytesUnusable) },
    };
  }, [sources, read]);

  const pausedMessage =
    upload?.state === "paused"
      ? upload.pauseReason === "signed-out"
        ? t.savePausedSignedOut
        : upload.pauseReason === "day-budget"
          ? t.savePausedDayBudget
          : t.savePausedOffline
      : null;
  const saveState = upload ? toSaveState(upload, pausedMessage) : legacySave;

  const saveLine = (() => {
    if (!upload || upload.state === "cancelled") {
      return null;
    }
    const lines = [t.saveLive(upload.inserted, upload.duplicates, upload.refused)];
    if (upload.originalsStored > 0) {
      lines.push(t.originalsKept(upload.originalsStored, formatBytes(upload.originalsBytes, locale)));
    }
    return lines.join(" · ");
  })();

  const saveStatus = (() => {
    if (!upload) {
      return null;
    }
    if (upload.state === "retrying" && upload.retryAt) {
      return t.saveRetrying(Math.max(1, Math.ceil((upload.retryAt - now) / 1000)));
    }
    if (upload.state === "waiting-budget" && upload.retryAt) {
      return t.saveWaitingBudget(
        new Date(upload.retryAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
      );
    }
    return pausedMessage;
  })();

  const allFailures = useMemo(() => sources.flatMap((source) => source.failures), [sources]);
  const busy = converting || reading;

  // The account's other tabs and devices see this upload live (R4.3): state
  // and counts only, on the account's private channel, throttled; withdrawn
  // when the upload is reset or this page goes away.
  const liveUserId = isDatabaseConfigured && auth.isSignedIn ? (auth.user?.id ?? null) : null;
  const liveActivity = useMemo(
    () =>
      upload && uploadId
        ? uploadActivityOf(uploadId, upload, { ...progress.extent, converting: busy })
        : null,
    [upload, uploadId, progress.extent, busy],
  );
  useUploadPresence(liveUserId, liveActivity);
  const showProgress = busy || saving || upload?.state === "paused";
  // Results appear while the conversion is still running: batches arrive every
  // ~60 ms, so the counts tick up and the first hands are previewable long
  // before a big file finishes. Measured at 1440px with the 7.9 MB corpus, the
  // main thread still held ~60 fps (p95 frame gap 18 ms) with the list live.
  const hasResults = sources.length > 0 && !reading;
  const hasFinished = hasResults && !converting;
  const recordedNow = upload?.failuresRecorded ?? recorded;

  return (
    <div className="conv">
      <section className="card conv-intro">
        <DropZone onFiles={handleFiles} onText={handleText} busy={busy || saving} siteNames={siteNames} />

        <div className="conv-controls">
          <div className="conv-switches">
            <label className={`conv-switch ${!isDatabaseConfigured ? "is-disabled" : ""}`}>
              <input
                type="checkbox"
                checked={autoSave}
                disabled={!isDatabaseConfigured}
                onChange={(event) => {
                  setAutoSave(event.target.checked);
                  try {
                    localStorage.setItem(AUTO_SAVE_KEY, event.target.checked ? "on" : "off");
                  } catch {
                    // Preference is a nicety; losing it is not worth an error.
                  }
                }}
              />
              <span className="conv-switch__track" aria-hidden="true">
                <span className="conv-switch__thumb" />
              </span>
              <span className="conv-switch__text">
                <strong>{t.autoSave}</strong>
                {/* Only the two cases a person cannot work out for themselves:
                    the feature is missing, or it needs an account they have not
                    got yet. When it simply works, the toggle says everything. */}
                {!isDatabaseConfigured ? (
                  <small>{t.autoSaveUnavailable}</small>
                ) : !auth.isSignedIn ? (
                  <small>{t.autoSaveSignedOut}</small>
                ) : null}
              </span>
            </label>

            {/* A2: the original files leave the tab only on this explicit,
                per-visit opt-in, and only into the user's own private folder. */}
            {isDatabaseConfigured && autoSave && auth.isSignedIn ? (
              <label className="conv-switch">
                <input
                  type="checkbox"
                  checked={keepOriginals}
                  disabled={busy || saving}
                  onChange={(event) => setKeepOriginals(event.target.checked)}
                />
                <span className="conv-switch__track" aria-hidden="true">
                  <span className="conv-switch__thumb" />
                </span>
                <span className="conv-switch__text">
                  <strong>{t.keepOriginals}</strong>
                  <small>{t.keepOriginalsHint}</small>
                </span>
              </label>
            ) : null}
          </div>

          {sources.length > 0 ? (
            <button type="button" className="btn btn--ghost" onClick={reset} disabled={busy}>
              {t.startOver}
            </button>
          ) : null}
        </div>

        {!isDatabaseConfigured ? (
          <p className="notice notice--warn">{t.dbNotConfigured}</p>
        ) : null}

        {resumable && !busy ? (
          <div className="notice notice--info conv-signin">
            <span>
              {t.resumeNotice(
                new Date(resumable.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
                resumable.counts.sourcesDone,
                resumable.counts.inserted + resumable.counts.duplicates,
              )}
            </span>
            <span className="conv-signin__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={forgetResumable}>
                {t.resumeForget}
              </button>
            </span>
          </div>
        ) : null}

        {/* The held-results offer. Deliberately phrased around what is already
            done, not what is being asked for: the work exists, it just has
            nowhere to live yet. */}
        {held ? (
          <div className="notice notice--info conv-signin">
            <span>{held.kind === "hands" ? t.held(held.hands.length) : t.heldTooMany(held.count)}</span>
            <span className="conv-signin__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() =>
                  auth.requestSignIn(t.heldSignInReason(held.kind === "hands" ? held.hands.length : held.count))
                }
              >
                {t.signInAndSave}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHeld(null)}>
                {t.notNow}
              </button>
            </span>
          </div>
        ) : null}

        {error ? <p className="notice notice--error">{error}</p> : null}
      </section>

      {showProgress ? (
        <section className="card conv-progress" aria-live="polite">
          <div className="conv-progress__head">
            <strong>
              {reading
                ? t.readingFiles
                : progress.current
                  ? t.convertingFile(progress.current.name)
                  : converting
                    ? t.converting
                    : saveLine}
            </strong>
            {busy ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => jobRef.current?.cancel()}>
                {t.stop}
              </button>
            ) : upload?.state === "paused" ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => saverRef.current?.resume()}>
                {t.saveRetry}
              </button>
            ) : null}
          </div>
          <div
            className="conv-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <span className="conv-bar__fill" style={{ width: `${Math.max(2, progress.percent)}%` }} />
          </div>
          <p className="muted conv-progress__detail">
            {t.progressBulk(
              progress.handsDone,
              progress.filesDone,
              formatBytes(read.bytes, locale),
              formatBytes(read.total, locale),
              progress.percent,
            )}
          </p>
          {busy && saveLine ? <p className="muted conv-progress__detail">{saveLine}</p> : null}
          {read.done > 0 ? <p className="muted conv-progress__detail">{t.resumed(read.done)}</p> : null}
          {saveStatus ? <p className="notice notice--warn conv-progress__detail">{saveStatus}</p> : null}
        </section>
      ) : null}

      {hasFinished && read.other > 0 ? (
        <p className="muted conv-footnote">{t.skippedOther(read.other)}</p>
      ) : null}

      {hasResults ? (
        <ResultsPanel
          sources={sources}
          saveState={saveState}
          dbConfigured={isDatabaseConfigured}
          autoSave={autoSave}
          onRetrySave={() => {
            const saver = saverRef.current;
            if (saver && saver.progress().state === "paused") {
              saver.resume();
              setUpload(saver.progress());
            }
          }}
          onPreview={setPreview}
          onOpenInReplayer={(hand) => openInReplayer(hand)}
          siteLabel={siteLabel}
          converting={converting}
        />
      ) : null}

      {/* The failure panel waits for the end: its whole message is "here is what
          we did with them", and that is not knowable mid-run. */}
      {hasFinished && allFailures.length > 0 ? (
        <FailurePanel
          failures={allFailures}
          siteLabel={siteLabel}
          recorded={recordedNow}
          notKept={!isDatabaseConfigured ? "no-database" : !autoSave ? "saving-off" : null}
        />
      ) : null}

      {usedWorker === false && hasFinished ? (
        <p className="muted conv-footnote">
          {t.noWorker}
        </p>
      ) : null}

      {preview ? (
        <HandPreview
          hand={preview}
          onClose={() => setPreview(null)}
          onOpenInReplayer={(hand, text) => {
            setPreview(null);
            openInReplayer(hand, text);
          }}
        />
      ) : null}
    </div>
  );
}
