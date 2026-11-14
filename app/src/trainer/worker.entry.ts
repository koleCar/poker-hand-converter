/** The trainer worker's entry (`new Worker(new URL("./worker.entry.ts", import.meta.url))`): see `worker.ts`. */
import { createTrainerWorker } from "./worker";

createTrainerWorker(self as unknown as Parameters<typeof createTrainerWorker>[0]);
