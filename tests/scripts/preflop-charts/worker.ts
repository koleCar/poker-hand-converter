// Worker thread for the chart generator: runs turn+river realisation solves
// (`measureRealisation`) handed to it by `pool.ts`, one message per job.
import { parentPort } from "node:worker_threads";

import { measureRealisation, type RealisationSpot } from "../../../frontend/src/lib/solver/preflopRealisation";

parentPort?.on("message", (message: { id: number; job: RealisationSpot }) => {
  parentPort?.postMessage({ id: message.id, sample: measureRealisation(message.job) });
});
