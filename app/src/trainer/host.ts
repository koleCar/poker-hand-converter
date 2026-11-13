/**
 * The Trainer's host in the app: the words of the app's language, a trainer
 * worker of its own (`worker.ts`) whose flop library files come through Rust,
 * "For you" read from the local store's leak rows (the same sums the top
 * leaks card ranks, `lib/leaksSource.ts`, grouped into focus areas as the
 * web groups them), and the settings kept in this window's storage. Answers
 * are not kept: the app has no trainer history yet.
 */
import { useMemo } from "react";

import { fetchOutcomeOfError } from "../analysis/workerClient";
import type { FetchOutcome } from "../analysis/worker";
import { useLocale } from "../i18n";
import { INTL_LOCALE } from "../i18n/types";
import type { GameKind } from "@rail/ui/hands/gameKind";
import { fetchTopLeaks } from "../lib/leaksSource";
import { errorText, inApp, ipc } from "../lib/ipc";
import {
  focusAreas,
  parseSettings,
  settingsFields,
  trainerEn,
  trainerHr,
  type FocusState,
  type GradedAnswer,
  type TrainerHost,
  type TrainerSettings,
  type TrainerSpot,
  type TrainingRequest,
  type TrainingResponse,
} from "./door";
import type { TrainerWorkerRequest, TrainerWorkerResponse } from "./worker";

const STORAGE_KEY = "rail.trainer.settings";

export function storedSettings(): TrainerSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return parseSettings(raw ? (JSON.parse(raw) as Record<string, unknown>) : null);
  } catch {
    return parseSettings(null);
  }
}

function keepSettings(settings: TrainerSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsFields(settings)));
  } catch {
    // A webview without storage: the settings live for the window's life.
  }
}

async function libraryFile(path: string): Promise<FetchOutcome> {
  try {
    return { kind: "bytes", bytes: await ipc.flopLibraryFile(path) };
  } catch (error) {
    return fetchOutcomeOfError(errorText(error));
  }
}

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, (response: TrainingResponse) => void>();

function trainerWorker(): Worker {
  if (worker) return worker;
  const made = new Worker(new URL("./worker.entry.ts", import.meta.url), { type: "module", name: "rail-trainer" });
  made.onmessage = (event: MessageEvent<TrainerWorkerResponse>) => {
    const message = event.data;
    if (message.type === "fetch") {
      // Outside the app there is no Rust to read the file: the flop is graded without the library.
      const outcome: Promise<FetchOutcome> = inApp ? libraryFile(message.path) : Promise.resolve({ kind: "offline" });
      void outcome.then((answer) => {
        const reply: TrainerWorkerRequest = { type: "fetched", reqId: message.reqId, outcome: answer };
        made.postMessage(reply, answer.kind === "bytes" ? [answer.bytes] : []);
      });
      return;
    }
    const resolve = pending.get(message.jobId);
    pending.delete(message.jobId);
    resolve?.(message);
  };
  worker = made;
  return made;
}

/** A job without its id: the id is given here. */
type Job = TrainingRequest extends infer R ? (R extends { jobId: number } ? Omit<R, "jobId"> : never) : never;

function ask(job: Job): Promise<TrainingResponse> {
  sequence += 1;
  const jobId = sequence;
  return new Promise((resolve) => {
    pending.set(jobId, resolve);
    trainerWorker().postMessage({ ...job, jobId } as TrainingRequest);
  });
}

async function deal(request: Parameters<TrainerHost["deal"]>[0], seed: number): Promise<TrainerSpot | null> {
  const response = await ask({ type: request.kind, options: request.options, seed } as Job);
  if (response.type === "error") throw new Error(response.message);
  return response.type === "spot" ? response.spot : null;
}

async function grade(spot: TrainerSpot, menuIndex: number): Promise<GradedAnswer> {
  const response = await ask({ type: "answer", spot, menuIndex });
  if (response.type === "error") throw new Error(response.message);
  if (response.type !== "graded") throw new Error(`unexpected ${response.type} from the trainer`);
  return { hand: response.hand, actionIndex: response.actionIndex, decision: response.decision, study: response.study ?? null };
}

/** "For you" from the store: every analysed hand of one kind of game, grouped into focus areas. */
async function focus(kind: GameKind | null): Promise<FocusState> {
  if (!inApp) return { status: "signed-out" };
  const report = await fetchTopLeaks({ gameKind: kind ?? "cash" }, "all");
  return { status: "ready", areas: focusAreas(report.sample.rows, report.sample.hands) };
}

export function useAppTrainerHost(kind: GameKind | null): TrainerHost {
  const locale = useLocale();
  return useMemo<TrainerHost>(
    () => ({
      t: locale === "hr" ? trainerHr : trainerEn,
      locale: INTL_LOCALE[locale],
      deal,
      grade,
      focus: () => focus(kind),
      onSettings: keepSettings,
    }),
    [locale, kind],
  );
}
