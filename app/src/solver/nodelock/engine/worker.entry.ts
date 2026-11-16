/** The nodelock worker's entry (`new Worker(new URL("./worker.entry.ts", import.meta.url))`): see `worker.ts`. */
import { createNodelockWorker, type WorkerScope } from "./worker";

createNodelockWorker(self as unknown as WorkerScope);
