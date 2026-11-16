/**
 * The nodelock engine's workers: a fixed pool of module workers, each
 * answering one request at a time by id.
 */
import type { EngineRequest, EngineResponse } from "./protocol";

/** Makes a worker; tests replace it. */
export type MakeWorker = (index: number) => Worker;

export const defaultWorker: MakeWorker = (index) =>
  new Worker(new URL("./worker.entry.ts", import.meta.url), { type: "module", name: `rail-nodelock-${index}` });

type Pending = { resolve: (message: EngineResponse) => void; reject: (error: Error) => void; onProgress?: (message: EngineResponse) => void };

/** Requests without an id: the pool numbers them. */
export type PoolRequest = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export class WorkerPool {
  private workers: (Worker | null)[];
  private readonly pending = new Map<number, Pending>();
  /** Which worker each pending request went to. */
  private readonly workerOf = new Map<number, number>();
  private seq = 0;

  constructor(
    readonly size: number,
    private readonly make: MakeWorker = defaultWorker,
  ) {
    this.workers = new Array(size).fill(null);
  }

  private worker(index: number): Worker {
    const live = this.workers[index];
    if (live) return live;
    const made = this.make(index);
    made.onmessage = (event: MessageEvent<EngineResponse>) => {
      const message = event.data;
      const job = this.pending.get(message.id);
      if (!job) return;
      if (message.type === "progress") {
        job.onProgress?.(message);
        return;
      }
      this.pending.delete(message.id);
      this.workerOf.delete(message.id);
      if (message.type === "error") job.reject(new Error(message.message));
      else job.resolve(message);
    };
    made.onerror = (event) => {
      event.preventDefault?.();
      this.kill(index, new Error(`nodelock worker ${index} failed: ${event.message ?? "unknown error"}`));
    };
    this.workers[index] = made;
    return made;
  }

  /** Sends a request to worker `index` and waits for its answer. */
  call(index: number, request: PoolRequest, onProgress?: (message: EngineResponse) => void, transfer: Transferable[] = []): Promise<EngineResponse> {
    const worker = this.worker(index);
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.workerOf.set(id, index);
      worker.postMessage({ ...request, id } as EngineRequest, transfer);
    });
  }

  /** Terminates worker `index` (its pending requests fail with `reason`); the next call starts a new one. */
  kill(index: number, reason: Error): void {
    this.workers[index]?.terminate();
    this.workers[index] = null;
    for (const [id, at] of this.workerOf) {
      if (at !== index) continue;
      this.workerOf.delete(id);
      const job = this.pending.get(id);
      this.pending.delete(id);
      job?.reject(reason);
    }
  }

  /** Terminates every worker. */
  stop(): void {
    for (let index = 0; index < this.size; index += 1) this.kill(index, new Error("the nodelock engine stopped"));
  }
}
