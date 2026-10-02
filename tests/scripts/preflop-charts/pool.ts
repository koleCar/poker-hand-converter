/**
 * Runs the generator's turn+river realisation solves on worker threads.
 *
 * The worker (`worker.ts`) imports the frontend's TypeScript, which plain Node
 * cannot load from a worker (extensionless imports), so it is bundled once
 * with esbuild (vite's own dependency) into `.cache/`. Results are returned in
 * job order, so the outcome does not depend on which thread finished first.
 */

import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import type { RealisationSample, RealisationSpot } from "../../../frontend/src/lib/solver/preflopRealisation.js";

export function workerPool(threads = availableParallelism(), log = (line: string) => console.log(line)) {
  const bundle = join(import.meta.dirname, ".cache/realisation-worker.mjs");
  buildSync({
    entryPoints: [join(import.meta.dirname, "worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
    logLevel: "warning",
  });
  return async (jobs: RealisationSpot[]): Promise<RealisationSample[]> => {
    const results: RealisationSample[] = new Array(jobs.length);
    if (!jobs.length) return results;
    const started = performance.now();
    let next = 0;
    let done = 0;
    await new Promise<void>((resolve, reject) => {
      const count = Math.min(threads, jobs.length);
      for (let w = 0; w < count; w += 1) {
        const worker = new Worker(bundle);
        const feed = () => {
          if (next >= jobs.length) {
            void worker.terminate();
            return;
          }
          const id = next;
          next += 1;
          worker.postMessage({ id, job: jobs[id] });
        };
        worker.on("message", (message: { id: number; sample: RealisationSample }) => {
          results[message.id] = message.sample;
          done += 1;
          if (done % 200 === 0 || done === jobs.length) {
            log(`  realisation solves: ${done}/${jobs.length} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
          }
          if (done === jobs.length) resolve();
          feed();
        });
        worker.on("error", reject);
        feed();
      }
    });
    return results;
  };
}

/**
 * Wraps a runner with a disk cache in `.cache/`, keyed by a hash of every job
 * (ranges, deal, pot, stack, menu, iterations), so rerunning the generator
 * after a change to the fit or the report does not solve the same spots
 * again. A changed solver must clear `.cache/` (the key does not cover code).
 */
export function cachedRun(
  run: (jobs: RealisationSpot[]) => Promise<RealisationSample[]>,
  log = (line: string) => console.log(line),
) {
  return async (jobs: RealisationSpot[]): Promise<RealisationSample[]> => {
    const hash = createHash("sha256");
    const seen = new Map<unknown, number>();
    for (const job of jobs) {
      for (const range of job.ranges) {
        if (!seen.has(range)) {
          seen.set(range, seen.size);
          hash.update(Buffer.from(Float64Array.from(range).buffer));
        }
      }
      hash.update(
        JSON.stringify([job.board, job.rivers ?? null, job.pot, job.stack, job.firstToAct, job.menu, job.raiseCap, job.iterations, job.ranges.map((r) => seen.get(r))]),
      );
    }
    const dir = join(import.meta.dirname, ".cache");
    const file = join(dir, `realisation-${hash.digest("hex").slice(0, 16)}.json`);
    if (existsSync(file)) {
      log(`  realisation solves: ${jobs.length} from cache ${file}`);
      const raw = JSON.parse(readFileSync(file, "utf8")) as { weight: number[][]; share: number[][]; equity: number[][] }[];
      return raw.map((s) => ({
        weight: [Float64Array.from(s.weight[0]), Float64Array.from(s.weight[1])],
        share: [Float64Array.from(s.share[0]), Float64Array.from(s.share[1])],
        equity: [Float64Array.from(s.equity[0]), Float64Array.from(s.equity[1])],
      }));
    }
    const out = await run(jobs);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(out.map((s) => ({ weight: s.weight.map((x) => Array.from(x)), share: s.share.map((x) => Array.from(x)), equity: s.equity.map((x) => Array.from(x)) }))),
    );
    return out;
  };
}
