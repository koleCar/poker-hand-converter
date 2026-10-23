/**
 * The analysis in the running app (R5.4): one {@link AnalysisRunner} over
 * the Tauri commands and the worker, started by `main.tsx` (its first look
 * waits, so nothing heavy runs on startup), woken by imports and by a table
 * closing, stopped at once by a table opening (A10). The screens read its
 * status with {@link useAnalysisStatus} and hear written rows with
 * {@link onAnalysisRows}.
 */
import { useSyncExternalStore } from "react";

import { errorText, inApp, ipc, onTablesOpen, onWatcherChanged } from "../lib/ipc";
import type { PageHand } from "./engine";
import { ANALYSIS_VERSION, handAnalysisFromStored, VILLAIN_MIN_HANDS, VillainCounters, type HandAnalysis, type PhfHand } from "./library";
import { AnalysisRunner, type RunnerDeps, type RunnerStatus } from "./runner";
import type { FetchOutcome } from "./worker";
import { fetchOutcomeOfError, workerAnalyser } from "./workerClient";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** One flop library file for the worker, through Rust (the disk, else the web's public bucket). */
async function fetchLibraryFile(path: string): Promise<FetchOutcome> {
  try {
    return { kind: "bytes", bytes: await ipc.flopLibraryFile(path) };
  } catch (error) {
    return fetchOutcomeOfError(errorText(error));
  }
}

const pageWorker = workerAnalyser(fetchLibraryFile);

/** The runner's dependencies in the app. */
export const appDeps: RunnerDeps = {
  gate: () => ipc.analysisGate(),
  counts: (version) => ipc.analysisCounts(version),
  pending: (version, after, limit) => ipc.analysisPending(version, after, limit),
  offline: (version, limit) => ipc.analysisOffline(version, limit),
  reachable: () => ipc.flopLibraryReachable().catch(() => false),
  villains: (players, minHands) => ipc.analysisVillains(players, minHands),
  analyse: (page, villains, library, signal) => pageWorker.analyse(page, villains, library, signal),
  save: (rows) => ipc.analysisSave(rows),
  sleep,
  now: () => Date.now(),
  // Idle: the worker goes, and with it the chart sets it loaded (hundreds of MB).
  release: () => pageWorker.stop(),
};

export const runner = new AnalysisRunner(appDeps);

let started = false;

/** Start the runner (once) and wire it to the app's events. Outside the app: nothing. */
export function startAnalysis(): void {
  if (!inApp || started) return;
  started = true;
  onTablesOpen((open) => runner.tablesOpen(open));
  onWatcherChanged(() => runner.wake());
  runner.start();
}

/** Pause or resume (kept across restarts by the store). */
export async function setAnalysisPaused(paused: boolean): Promise<void> {
  await ipc.analysisSetPaused(paused);
  runner.paused(paused);
}

/** The runner's status, for a screen. */
export function useAnalysisStatus(): RunnerStatus {
  return useSyncExternalStore(
    (listener) => runner.subscribe(listener),
    () => runner.current(),
  );
}

/** Hear when the runner wrote rows. */
export function onAnalysisRows(listener: () => void): () => void {
  return runner.onRows(listener);
}

/* ---------------------------------------------------------- one hand - */

const handWorker = workerAnalyser(fetchLibraryFile);
let handVillains: { at: number; counters: VillainCounters } | null = null;

/**
 * A hand's analysis for the hand view: the stored row at the app's version,
 * else the hand analysed now (not stored: the runner will). Null outside
 * the app.
 */
export async function handAnalysisOf(handKey: string, phf: PhfHand): Promise<{ analysis: HandAnalysis; stored: boolean } | null> {
  if (!inApp) return null;
  const row = await ipc.handAnalysis(handKey);
  if (row && row.analysisVersion === ANALYSIS_VERSION) {
    return { analysis: handAnalysisFromStored(row), stored: true };
  }
  // The opponents' statistics as the runner would read them (a snapshot at most ten minutes old).
  const now = Date.now();
  if (!handVillains || now - handVillains.at > 10 * 60_000) {
    handVillains = { at: now, counters: new VillainCounters((players) => ipc.analysisVillains(players, VILLAIN_MIN_HANDS)) };
  }
  const villains = await handVillains.counters.statsFor([phf]).catch(() => null);
  const hand: PageHand = { handKey, phf };
  const library = runner.current().library;
  return { analysis: await handWorker.hand(hand, villains, library), stored: false };
}
