/**
 * The Solver library's live turns, from the page's side: a turn card picked
 * on a library chunk is solved in a worker (`workers/liveTurn.worker.ts`) and
 * comes back as a turn chunk, the flop's header with the turn's solve - what
 * a full solve's turn file decodes to (fullSolve.ts), so the page walks both
 * the same way.
 *
 * Solves are kept for the page's life (a handful: ~1–3 MB each), so going
 * back to a turn already seen is instant. One solve runs at a time: asking
 * for another turn terminates the worker and starts again.
 */

import { solveLiveTurn, type FlopChunk, type LiveTurnProgress } from "../../lib/solver";
import type { LiveTurnRequest, LiveTurnResponse } from "../../workers/liveTurn.worker";

/** Turn solves kept, most recent last. */
const KEEP = 12;
const done = new Map<string, FlopChunk>();

let worker: Worker | null = null;
let running: { key: string; promise: Promise<FlopChunk>; listeners: Set<(p: LiveTurnProgress) => void> } | null = null;
let cancel: (() => void) | null = null;
let sequence = 0;

/** The URL / state form of a live turn: the chunk's deal node and the card (`12~Kd`). */
export function liveTurnId(chance: number, card: string): string {
  return `${chance}~${card}`;
}

export function parseLiveTurnId(id: string): { chance: number; card: string } | null {
  const match = /^(\d{1,5})~([2-9TJQKA][cdhs])$/.exec(id);
  return match ? { chance: Number(match[1]), card: match[2] } : null;
}

function keep(key: string, chunk: FlopChunk) {
  done.delete(key);
  done.set(key, chunk);
  while (done.size > KEEP) done.delete(done.keys().next().value!);
}

/** A solve already done, or null. */
export function liveTurnCached(chunkKey: string, chance: number, card: string): FlopChunk | null {
  return done.get(`${chunkKey}/${liveTurnId(chance, card)}`) ?? null;
}

/**
 * The turn of `chunk`'s deal `chance` with `card` dealt (the chunk's suits),
 * solved; `onProgress` hears the solve's iterations. A second call for the
 * same turn joins the first; a call for another turn cancels it.
 */
export function solveTurnLive(
  chunkKey: string,
  chunk: FlopChunk,
  chance: number,
  card: string,
  onProgress?: (progress: LiveTurnProgress) => void,
): Promise<FlopChunk> {
  const key = `${chunkKey}/${liveTurnId(chance, card)}`;
  const cached = done.get(key);
  if (cached) return Promise.resolve(cached);
  if (running?.key === key) {
    if (onProgress) running.listeners.add(onProgress);
    return running.promise;
  }
  cancel?.();

  const listeners = new Set<(p: LiveTurnProgress) => void>(onProgress ? [onProgress] : []);
  const promise = (typeof Worker === "undefined" ? onMainThread(chunk, chance, card) : inWorker(chunk, chance, card, listeners)).then(
    (result) => {
      const turn: FlopChunk = { header: chunk.header, result };
      keep(key, turn);
      return turn;
    },
  );
  const entry = { key, promise, listeners };
  running = entry;
  const clear = () => {
    if (running === entry) running = null;
  };
  promise.then(clear, clear);
  return promise;
}

async function onMainThread(chunk: FlopChunk, chance: number, card: string) {
  // Yield first so the "solving" state can paint.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return solveLiveTurn(chunk, chance, card);
}

function inWorker(chunk: FlopChunk, chance: number, card: string, listeners: Set<(p: LiveTurnProgress) => void>) {
  worker ??= new Worker(new URL("../../workers/liveTurn.worker.ts", import.meta.url), { type: "module", name: "rail-live-turn" });
  const live = worker;
  const id = (sequence += 1);
  return new Promise<FlopChunk["result"]>((resolve, reject) => {
    const onMessage = (event: MessageEvent<LiveTurnResponse>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === "progress") {
        for (const listener of listeners) listener({ iteration: message.iteration, exploitabilityPct: message.exploitabilityPct });
        return;
      }
      live.removeEventListener("message", onMessage);
      cancel = null;
      if (message.type === "done") resolve(message.result);
      else reject(new Error(message.message));
    };
    live.addEventListener("message", onMessage);
    cancel = () => {
      live.removeEventListener("message", onMessage);
      live.terminate();
      if (worker === live) worker = null;
      cancel = null;
      reject(new Error("cancelled"));
    };
    live.postMessage({ id, chunk, chance, card } satisfies LiveTurnRequest);
  });
}
