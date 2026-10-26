/** The analysis worker's entry (`new Worker(new URL("./worker.entry.ts", import.meta.url))`): see `worker.ts`. */
import { createWorker } from "./worker";

createWorker(self as unknown as Parameters<typeof createWorker>[0]);
