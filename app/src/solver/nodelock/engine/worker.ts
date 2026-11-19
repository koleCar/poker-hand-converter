/**
 * A nodelock worker (`docs/NODELOCK.md` §2.5): one part of a split flop
 * solve - the subtrees of its own turn cards, kept between solves for a
 * warm start - or a whole turn or river lock.
 */
import { decodeChunk, nodelockSpotOf, SplitPart, solveNodelock, type NodelockSolve } from "./door";
import type { EngineRequest, EngineResponse } from "./protocol";

/** The worker's global scope, as much of it as this uses. */
export interface WorkerScope {
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
  postMessage(message: EngineResponse, transfer?: Transferable[]): void;
}

export function createNodelockWorker(scope: WorkerScope): void {
  let part: { key: string; part: SplitPart } | null = null;
  /** The last turn lock's solve, for a warm start of the next lock on the same deal. */
  let turn: { key: string; solve: NodelockSolve } | null = null;
  const post = (message: EngineResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

  scope.onmessage = (event) => {
    const message = event.data;
    try {
      switch (message.type) {
        case "part": {
          if (part?.key !== message.key) {
            part = null;
            part = { key: message.key, part: new SplitPart(message.spec, message.cards) };
          }
          post({ type: "ready", id: message.id, bytes: part.part.bytes, valueSum: part.part.valueSum });
          return;
        }
        case "traverse": {
          if (!part) throw new Error("no part built");
          const values = part.part.traverse(message.step);
          post({ type: "values", id: message.id, values }, [values.values.buffer, values.units.buffer, values.edges.buffer]);
          return;
        }
        case "restart": {
          part?.part.solver.restartAverage(message.iteration);
          post({ type: "restarted", id: message.id });
          return;
        }
        case "turn": {
          const baseline = decodeChunk(message.baseline);
          const spot = nodelockSpotOf(message.lockSet, baseline);
          if (spot.street !== "turn") throw new Error("a flop lock is solved split, not in one worker");
          // The chunk it is dealt from is part of the game: the same deal on a locked flop has other ranges.
          const key = JSON.stringify([message.lockSet.spot, baseline.header.lockHash ?? null, spot.deal, spot.card, spot.spot.symmetry, spot.spot.nodeActions ?? null]);
          const warm = turn?.key === key ? turn.solve.warm : undefined;
          turn = null;
          let last = 0;
          const solve = solveNodelock(spot, message.lockSet, {
            baseline,
            maxIterations: message.maxIterations,
            warm,
            onIteration: (p) => {
              const now = Date.now();
              if (now - last < 100) return;
              last = now;
              post({ type: "progress", id: message.id, iteration: p.iteration, exploitabilityPct: p.exploitabilityPct, memoryMb: 0 });
            },
          });
          turn = { key, solve };
          post({ type: "turned", id: message.id, chunk: solve.chunk, stats: solve.stats, warm: solve.stats.warm }, [solve.chunk.buffer]);
          return;
        }
      }
    } catch (error) {
      post({ type: "error", id: message.id, message: error instanceof Error ? error.message : String(error) });
    }
  };
}
