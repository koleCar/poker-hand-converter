/**
 * One flop library solve, in its own process (forked by `run.ts`).
 *
 * A process per solve, not a worker thread: a solve holds one to two GB, a
 * fresh process returns all of it when it exits, its peak resident memory
 * is its own (`maxRSS`), and cancelling is a kill. The chunk is written here,
 * atomically (temporary file, then rename), so a solve that dies leaves
 * nothing behind and the queue simply runs it again.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { solveJob, type Job } from "./job.js";

interface Message {
  job: Job;
  /** Where the chunk and its stats go. */
  chunkFile: string;
  statsFile: string;
  /** Progress at most this often, ms. */
  progressMs: number;
}

function atomicWrite(file: string, data: Uint8Array | string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// The runner is gone (stopped, or crashed): nobody will collect this solve.
process.on("disconnect", () => process.exit(1));

process.on("message", (message: Message) => {
  const { job, chunkFile, statsFile, progressMs } = message;
  let last = 0;
  try {
    const { bytes, stats, cancelled } = solveJob(job, (progress) => {
      if (progress.elapsedMs - last >= progressMs) {
        last = progress.elapsedMs;
        process.send?.({ type: "progress", id: job.id, ...progress, rssMb: process.memoryUsage().rss / 1e6 });
      }
    });
    if (cancelled) {
      process.send?.({ type: "cancelled", id: job.id });
      process.exit(0);
    }
    const peakRssMb = process.resourceUsage().maxRSS / 1024;
    atomicWrite(chunkFile, bytes);
    atomicWrite(statsFile, `${JSON.stringify({ id: job.id, line: job.line, flop: job.flop, bytes: bytes.length, ...stats, peakRssMb }, null, 1)}\n`);
    process.send?.({ type: "done", id: job.id, bytes: bytes.length, ...stats, peakRssMb }, () => process.exit(0));
  } catch (error) {
    process.send?.({ type: "error", id: job.id, message: error instanceof Error ? (error.stack ?? error.message) : String(error) }, () =>
      process.exit(1),
    );
  }
});
