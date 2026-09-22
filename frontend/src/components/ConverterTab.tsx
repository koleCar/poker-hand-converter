/**
 * The converter — the app's front door.
 *
 * What it does, in order: take files (dropped, picked, pasted, zipped or in a
 * dropped folder), decode them properly, detect which poker room wrote them,
 * convert every hand off the main thread, save the good ones to the library and
 * the unconvertible ones to the failure corpus, and then let the user download
 * the result or open any single hand in the replayer.
 *
 * Three decisions worth knowing about:
 *
 *  * **Conversion starts as soon as files arrive.** There is no "convert" step.
 *    The intent of dropping a hand history on a hand history converter is not
 *    ambiguous, and the cancel button covers the accident.
 *  * **The work runs in a worker.** The 7.9 MB WePlay corpus takes ~2 s of
 *    straight CPU; on the main thread that is a frozen tab with no progress and
 *    no cancel. See `workers/convert.worker.ts`.
 *  * **Failures are a feature.** A hand we cannot read is stored on purpose as
 *    reference material for the next parser, and the user is told exactly that.
 *  * **A guest converts first and signs in afterwards.** Conversion never waits
 *    for an account. When a run finishes with nobody signed in, the results are
 *    held in memory and offered — "sign in to save these 412 hands" — so the
 *    work is never lost and the login never arrives before the value does.
 *
 * The page stays fully usable with no database and with no account: conversion,
 * preview, download and the replayer hand-off never touch Supabase.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../lib/auth";
import {
  DATABASE_NOT_CONFIGURED_MESSAGE,
  isDatabaseConfigured,
  recordConversionFailures,
  saveHands,
} from "../lib/db";
import { getParser, getParsers } from "../lib/phf";
import type { PhfHand } from "../lib/phf/types";
import { DropZone } from "./converter/DropZone";
import { FailurePanel } from "./converter/FailurePanel";
import { HandPreview } from "./converter/HandPreview";
import { ResultsPanel } from "./converter/ResultsPanel";
import { startConversion, type ConversionJob } from "./converter/conversionClient";
import { openHandInReplayer } from "./converter/handoff";
import { formatCount, loadFile, sourceFromText, type LoadedSource } from "./converter/inputs";
import type { PipelineBatch, PipelineSource } from "./converter/pipeline";
import { IDLE_SAVE, type SaveState, type SourceResult } from "./converter/types";
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

interface ConverterTabProps {
  /** Lets the shell refresh its stored-hand counter. Optional; defaults to a no-op. */
  onHandsSaved?: () => void;
  /**
   * Overrides how a hand is opened in the replayer.
   *
   * The default parks the hand in `sessionStorage` and navigates to `/replay`
   * (see `converter/handoff.ts`). Pass this once the shell can hand a loaded
   * hand to the replayer directly.
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

/** A decoded input becomes a result row straight away, before it is converted. */
function toResult(source: LoadedSource): SourceResult {
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
    hands: [],
    failures: [],
  };
}

/** A finished run that had nowhere to go because nobody was signed in. */
interface HeldSave {
  hands: PhfHand[];
  failures: Parameters<typeof recordConversionFailures>[0];
}

export function ConverterTab({ onHandsSaved, onOpenHand }: ConverterTabProps) {
  const [sources, setSources] = useState<SourceResult[]>([]);
  const [reading, setReading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(IDLE_SAVE);
  const [recorded, setRecorded] = useState<{ created: number; updated: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoSave, setAutoSave] = useState(readAutoSavePreference);
  const [preview, setPreview] = useState<PhfHand | null>(null);
  const [usedWorker, setUsedWorker] = useState<boolean | null>(null);
  const [held, setHeld] = useState<HeldSave | null>(null);

  const auth = useAuth();
  const jobRef = useRef<ConversionJob | null>(null);
  // Read inside the pipeline callbacks, which are created once per job and
  // would otherwise close over a stale toggle.
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave;
  const signedInRef = useRef(auth.isSignedIn);
  signedInRef.current = auth.isSignedIn;

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
      siteId ? getParser(siteId)?.name ?? siteId : "Format we do not know yet",
    [],
  );

  const openInReplayer = useCallback(
    (hand: PhfHand, standardText?: string) => {
      if (onOpenHand) {
        onOpenHand(hand, standardText ?? "");
        return;
      }
      openHandInReplayer(hand, standardText);
    },
    [onOpenHand],
  );

  /* ------------------------------------------------------------- saving - */

  const persist = useCallback(
    async (hands: PhfHand[], failures: Parameters<typeof recordConversionFailures>[0]) => {
      if (!isDatabaseConfigured || !autoSaveRef.current) {
        return;
      }

      // Nobody to store them under yet. Hold on to the results rather than
      // dropping them: the conversion has already happened, and asking the user
      // to re-drop a 7 MB folder after signing in would be the whole cost of
      // the run charged twice.
      if (!signedInRef.current) {
        setHeld({ hands, failures });
        setSaveState(IDLE_SAVE);
        return;
      }
      setHeld(null);

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
      setSaveState({ ...IDLE_SAVE, status: "saving", total: hands.length });
      try {
        const result = await saveHands(hands, {
          onProgress: (done, total) =>
            setSaveState((state) => ({ ...state, done, total })),
        });
        setSaveState({
          status: result.errors.length ? "error" : "done",
          inserted: result.inserted,
          duplicates: result.duplicates,
          total: result.received,
          done: result.received,
          errors: result.errors,
        });
        onHandsSaved?.();
      } catch (err) {
        // The converted output is already on screen and downloadable; a failed
        // write is a warning, never a reason to throw the results away.
        setSaveState({
          ...IDLE_SAVE,
          status: "error",
          total: hands.length,
          errors: [err instanceof Error ? err.message : String(err)],
        });
      }
    },
    [onHandsSaved],
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
    if (!auth.isSignedIn || !held) {
      return;
    }
    const pending = held;
    setHeld(null);
    void persist(pending.hands, pending.failures);
  }, [auth.isSignedIn, held, persist]);

  /* --------------------------------------------------------- conversion - */

  /**
   * Batches that have arrived but are not in React state yet.
   *
   * The worker produces a batch roughly every 60 ms, and re-rendering the whole
   * results panel that often costs real frames: measured on the 7.9 MB corpus
   * with the live list, the 95th percentile frame gap went from 18 ms to 32 ms.
   * Coalescing the batches into one state update every {@link FLUSH_MS} brings
   * it back while still looking continuous — nobody can tell 8 updates a second
   * from 16, but the main thread can.
   */
  const pendingRef = useRef(new Map<string, PipelineBatch>());
  const flushTimerRef = useRef<number | null>(null);

  /**
   * Stop the worker and the flush timer when the tab goes away.
   *
   * The app has a real router now, so navigating to the replayer mid-conversion
   * is something a user can actually do — and a worker nobody is listening to
   * keeps burning a core while its `postMessage` handlers set state on an
   * unmounted component.
   */
  useEffect(
    () => () => {
      jobRef.current?.cancel();
      jobRef.current = null;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = new Map();
    },
    [],
  );

  const flushBatches = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (pending.size === 0) {
      return;
    }
    pendingRef.current = new Map();
    setSources((current) =>
      current.map((source) => {
        const batch = pending.get(source.id);
        if (!batch) {
          return source;
        }
        return {
          ...source,
          done: batch.done,
          total: batch.total,
          hands: source.hands.concat(batch.hands),
          failures: source.failures.concat(batch.failures),
        };
      }),
    );
  }, []);

  const queueBatch = useCallback(
    (batch: PipelineBatch) => {
      const existing = pendingRef.current.get(batch.sourceId);
      pendingRef.current.set(
        batch.sourceId,
        existing
          ? {
              ...batch,
              hands: existing.hands.concat(batch.hands),
              failures: existing.failures.concat(batch.failures),
            }
          : batch,
      );
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushBatches, FLUSH_MS);
      }
    },
    [flushBatches],
  );

  const convert = useCallback(
    (runnable: PipelineSource[]) => {
      if (runnable.length === 0) {
        return;
      }

      setConverting(true);
      setError(null);
      setSaveState(IDLE_SAVE);
      setRecorded(null);

      const hands: PhfHand[] = [];
      const failures: Parameters<typeof recordConversionFailures>[0] = [];

      jobRef.current = startConversion(
        runnable,
        // Everything converts: the old tab was cash-only, but a user with a
        // tournament history wants it converted, not silently dropped.
        { validate: true },
        {
          onSourceStart: (start) =>
            setSources((current) =>
              current.map((source) =>
                source.id === start.sourceId
                  ? {
                      ...source,
                      status: "running",
                      siteId: start.siteId,
                      siteName: start.siteName,
                      confidence: start.confidence,
                      total: start.total,
                    }
                  : source,
              ),
            ),
          onBatch: (batch) => {
            hands.push(...batch.hands);
            failures.push(...batch.failures);
            queueBatch(batch);
          },
          onSourceEnd: (sourceId) => {
            // Flush first, so the row never flips to "done" while the last
            // batch of its hands is still sitting in the buffer.
            flushBatches();
            setSources((current) =>
              current.map((source) =>
                source.id === sourceId ? { ...source, status: "done" } : source,
              ),
            );
          },
          onDone: ({ cancelled, usedWorker: worker }) => {
            jobRef.current = null;
            flushBatches();
            setUsedWorker(worker);
            setConverting(false);
            setSources((current) =>
              current.map((source) =>
                source.status === "running" || source.status === "queued"
                  ? { ...source, status: cancelled ? "cancelled" : "done" }
                  : source,
              ),
            );
            // A cancelled run still saves what it converted; throwing away work
            // the user already waited for would be the wrong kind of tidy.
            void persist(hands, failures);
          },
          onError: (message) => {
            jobRef.current = null;
            flushBatches();
            setConverting(false);
            setError(message);
            setSources((current) =>
              current.map((source) =>
                source.status === "running" ? { ...source, status: "done" } : source,
              ),
            );
          },
        },
      );
    },
    [persist, queueBatch, flushBatches],
  );

  /* -------------------------------------------------------------- input - */

  const addSources = useCallback(
    (loaded: LoadedSource[]) => {
      if (loaded.length === 0) {
        return;
      }
      setSources((current) => [...current, ...loaded.map(toResult)]);
      // The decoded text is handed straight to the pipeline and never stored in
      // React state: 8 MB of text that nothing reads again is 8 MB of the tab's
      // memory spent on nothing.
      convert(
        loaded
          .filter((source) => !source.problem)
          .map((source) => ({ id: source.id, name: source.name, text: source.text })),
      );
    },
    [convert],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      setReading(true);
      setError(null);
      try {
        const loaded: LoadedSource[] = [];
        for (const file of files) {
          loaded.push(...(await loadFile(file)));
        }
        addSources(loaded);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Those files could not be read.");
      } finally {
        setReading(false);
      }
    },
    [addSources],
  );

  const handleText = useCallback(
    (text: string) => {
      const existing = sources.filter((source) => source.name.startsWith("Pasted text")).length;
      addSources([sourceFromText(text, existing ? `Pasted text ${existing + 1}` : "Pasted text")]);
    },
    [addSources, sources],
  );

  function reset() {
    jobRef.current?.cancel();
    jobRef.current = null;
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingRef.current = new Map();
    setSources([]);
    setSaveState(IDLE_SAVE);
    setRecorded(null);
    setError(null);
    setConverting(false);
    setPreview(null);
    setHeld(null);
  }

  /* ----------------------------------------------------------- progress - */

  const progress = useMemo(() => {
    const runnable = sources.filter((source) => !source.problem);
    const finished = runnable.filter((source) => source.status === "done" || source.status === "cancelled");
    const running = runnable.find((source) => source.status === "running");
    const handsDone = sources.reduce((sum, source) => sum + source.hands.length, 0);
    const fraction = runnable.length
      ? (finished.length + (running && running.total ? running.done / running.total : 0)) / runnable.length
      : 0;
    return {
      files: runnable.length,
      filesDone: finished.length,
      current: running ?? null,
      handsDone,
      percent: Math.min(100, Math.round(fraction * 100)),
    };
  }, [sources]);

  const allFailures = useMemo(() => sources.flatMap((source) => source.failures), [sources]);
  const busy = converting || reading;
  // Results appear while the conversion is still running: batches arrive every
  // ~60 ms, so the counts tick up and the first hands are previewable long
  // before a big file finishes. Measured at 1440px with the 7.9 MB corpus, the
  // main thread still held ~60 fps (p95 frame gap 18 ms) with the list live.
  const hasResults = sources.length > 0 && !reading;
  const hasFinished = hasResults && !converting;

  return (
    <div className="conv">
      <section className="card conv-intro">
        <header className="card__head">
          <div>
            <h2>Poker hand history converter</h2>
            <p className="muted">
              Drop a hand history from any poker room. We work out which site wrote it, convert it
              to the standard format Holdem Manager and PokerTracker import, and keep anything we
              cannot read yet so we can add support for it. Everything runs in your browser.
            </p>
          </div>
        </header>

        <DropZone onFiles={handleFiles} onText={handleText} busy={busy} siteNames={siteNames} />

        <div className="conv-controls">
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
              <strong>Save to my hand library</strong>
              <small>
                {!isDatabaseConfigured
                  ? "Unavailable in this build — converting, previewing and downloading all still work."
                  : auth.isSignedIn
                    ? "Converted hands go to your private library, and hands we cannot convert are kept as samples so we can add your site."
                    : "Convert now, sign in after. We will offer to save the results once the run finishes."}
              </small>
            </span>
          </label>

          {sources.length > 0 ? (
            <button type="button" className="btn btn--ghost" onClick={reset} disabled={busy}>
              Start over
            </button>
          ) : null}
        </div>

        {!isDatabaseConfigured ? (
          <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
        ) : null}

        {/* The held-results offer. Deliberately phrased around what is already
            done, not what is being asked for: the work exists, it just has
            nowhere to live yet. */}
        {held ? (
          <div className="notice notice--info conv-signin">
            <span>
              {formatCount(held.hands.length)}{" "}
              {held.hands.length === 1 ? "hand is" : "hands are"} converted and waiting. Sign in to
              keep {held.hands.length === 1 ? "it" : "them"} in your library — they stay private to
              your account.
            </span>
            <span className="conv-signin__actions">
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() =>
                  auth.requestSignIn(
                    `Sign in to save ${formatCount(held.hands.length)} converted ${
                      held.hands.length === 1 ? "hand" : "hands"
                    } to your library.`,
                  )
                }
              >
                Sign in and save
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setHeld(null)}>
                Not now
              </button>
            </span>
          </div>
        ) : null}

        {error ? <p className="notice notice--error">{error}</p> : null}
      </section>

      {busy ? (
        <section className="card conv-progress" aria-live="polite">
          <div className="conv-progress__head">
            <strong>
              {reading
                ? "Reading your files…"
                : progress.current
                  ? `Converting ${progress.current.name}`
                  : "Converting…"}
            </strong>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => jobRef.current?.cancel()}>
              Stop
            </button>
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
            {formatCount(progress.handsDone)} hands converted
            {progress.files > 1
              ? ` · file ${formatCount(Math.min(progress.filesDone + 1, progress.files))} of ${formatCount(progress.files)}`
              : ` · ${progress.percent}%`}
          </p>
        </section>
      ) : null}

      {hasResults ? (
        <ResultsPanel
          sources={sources}
          saveState={saveState}
          dbConfigured={isDatabaseConfigured}
          autoSave={autoSave}
          onRetrySave={() => void persist(sources.flatMap((source) => source.hands), [])}
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
          recorded={recorded}
          notKept={!isDatabaseConfigured ? "no-database" : !autoSave ? "saving-off" : null}
        />
      ) : null}

      {usedWorker === false && hasFinished ? (
        <p className="muted conv-footnote">
          This browser would not start a background worker, so conversion ran on the page itself.
          Large files may have felt slow.
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
